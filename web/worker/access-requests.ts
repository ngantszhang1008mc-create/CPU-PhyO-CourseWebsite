import type { Database } from './storage.ts';
import {
  authorizeStudent,
  CHALLENGE_AGE,
  clearStudentAccessRequest,
  digest,
  HttpError,
  randomToken,
  requireClientId,
  schoolProof,
  studentAddress,
  studentInvitations,
  studentValidityDays,
  verifySchoolProof,
  type User,
  type VerifyGoogle,
} from './security.ts';

function requireUnapproved(db: Database, address: Awaited<ReturnType<typeof studentAddress>>) {
  if (studentInvitations(db, address.email, address.emailHash, Date.now()).length)
    throw new HttpError(
      409,
      'Your CPU account number is authorized. Continue with registration.',
      'student_access_granted',
    );
}

export async function beginAccessRequest(
  db: Database,
  input: Record<string, unknown>,
  request: Request,
  fallbackClientId?: string,
) {
  const address = await studentAddress(input.studentNumber);
  const nonce = randomToken();
  const nonceHash = await digest(nonce);
  const ip = await digest(request.headers.get('CF-Connecting-IP') ?? 'local');
  return db.atomic(() => {
    requireUnapproved(db, address);
    const clientId = requireClientId(db, fallbackClientId);
    const now = Date.now();
    db.write('DELETE FROM access_request_challenges WHERE expires<=?', now);
    const { count } = db.all<{ count: number }>(
      'SELECT count(*) AS count FROM access_request_challenges WHERE ip_digest=?',
      ip,
    )[0];
    if (count >= 120)
      throw new HttpError(429, 'Too many verification requests. Try again in ten minutes.');
    db.write(
      'INSERT INTO access_request_challenges (digest,student_number,client_id,ip_digest,expires) VALUES (?,?,?,?,?)',
      nonceHash,
      address.studentNumber,
      clientId,
      ip,
      now + CHALLENGE_AGE,
    );
    return { required: true, email: address.email, nonce, clientId };
  });
}

function requestDetails(input: Record<string, unknown>) {
  const { yearOfStudy, phyTeamMember } = input;
  const studentName = typeof input.studentName === 'string' ? input.studentName.trim() : '';
  if (!studentName || studentName.length > 100 || /[\u0000-\u001f\u007f]/.test(studentName))
    throw new HttpError(400, 'Enter a student name of up to 100 characters.');
  if (
    typeof yearOfStudy !== 'number' ||
    !Number.isInteger(yearOfStudy) ||
    yearOfStudy < 1 ||
    yearOfStudy > 6
  )
    throw new HttpError(400, 'Choose a year of study from 1 to 6.');
  if (typeof phyTeamMember !== 'boolean')
    throw new HttpError(400, 'Choose whether you are a Physics Team member.');
  const justification =
    !phyTeamMember && typeof input.justification === 'string' ? input.justification.trim() : '';
  if (!phyTeamMember && (!justification || justification.length > 1000))
    throw new HttpError(400, 'Explain why you are requesting access in up to 1,000 characters.');
  return { studentName, yearOfStudy, phyTeamMember, justification };
}

export async function submitAccessRequest(
  db: Database,
  input: Record<string, unknown>,
  fallbackClientId?: string,
  verifyGoogle?: VerifyGoogle,
) {
  const address = await studentAddress(input.studentNumber);
  requireUnapproved(db, address);
  const { studentName, yearOfStudy, phyTeamMember, justification } = requestDetails(input);
  const proof = schoolProof(input);
  const nonceHash = await digest(proof.googleNonce);
  const clientId = requireClientId(db, fallbackClientId);
  function requireRequestProof() {
    const matches = db.all(
      'SELECT 1 FROM access_request_challenges WHERE digest=? AND student_number=? AND client_id=? AND expires>?',
      nonceHash,
      address.studentNumber,
      clientId,
      Date.now(),
    );
    if (!matches.length)
      throw new HttpError(403, 'Verify your school Google account again to submit this request.');
  }
  requireRequestProof();
  await verifySchoolProof(proof, clientId, address.email, verifyGoogle);
  return db.atomic(() => {
    // A grant, review or Google client change can land during the external identity check.
    requireUnapproved(db, address);
    requireRequestProof();
    if (
      db.all('SELECT 1 FROM access_requests WHERE student_number=?', address.studentNumber).length
    )
      return false;
    db.write(
      `INSERT INTO access_requests
       (id,student_number,student_name,year_of_study,phy_team_member,justification,created_at)
       VALUES (?,?,?,?,?,?,?)`,
      randomToken(),
      address.studentNumber,
      studentName,
      yearOfStudy,
      Number(phyTeamMember),
      justification,
      Date.now(),
    );
    return true;
  });
}

export function listAccessRequests(db: Database) {
  return db
    .all<{
      id: string;
      studentNumber: string;
      studentName: string;
      yearOfStudy: number;
      phyTeamMember: number;
      justification: string;
      createdAt: number;
    }>(
      `SELECT id, student_number AS studentNumber, student_name AS studentName,
     year_of_study AS yearOfStudy, phy_team_member AS phyTeamMember, justification,
     created_at AS createdAt FROM access_requests ORDER BY created_at, rowid`,
    )
    .map((row) => ({ ...row, phyTeamMember: Boolean(row.phyTeamMember) }));
}

export async function reviewAccessRequest(
  db: Database,
  id: string,
  input: Record<string, unknown>,
  requireAdmin: () => User,
) {
  const { decision } = input;
  if (decision !== 'approve' && decision !== 'decline')
    throw new HttpError(400, 'Choose whether to approve or decline the access request.');
  const days = studentValidityDays(input.validityDays);
  function pendingRequest() {
    const row = db.all<{ student_number: string }>(
      'SELECT student_number FROM access_requests WHERE id=?',
      id,
    )[0];
    if (!row) throw new HttpError(404, 'This access request is no longer pending.');
    return row;
  }
  const address = await studentAddress(pendingRequest().student_number);
  return db.atomic(() => {
    requireAdmin();
    pendingRequest();
    if (decision === 'approve') {
      authorizeStudent(db, address, days);
      return { status: 'approved' };
    }
    clearStudentAccessRequest(db, address.studentNumber);
    return { status: 'declined' };
  });
}
