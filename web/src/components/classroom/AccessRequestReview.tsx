import { useEffect, useState, type SubmitEvent } from 'react';
import { courseApi, explain } from '../../lib/classroom';
import { ValidityField, validityDays } from './ValidityField';

interface StudentRequest {
  id: string;
  studentNumber: string;
  studentName: string;
  yearOfStudy: number;
  phyTeamMember: boolean;
  justification: string;
}

export function AccessRequestReview({
  revision,
  onApproved,
}: {
  revision: number;
  onApproved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [requests, setRequests] = useState<StudentRequest[]>();
  const [reload, setReload] = useState(0);
  const [reviewing, setReviewing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [reviewError, setReviewError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoadError('');
    courseApi<{ requests: StudentRequest[] }>('access-requests', { signal: controller.signal })
      .then(({ requests }) => {
        if (!controller.signal.aborted) setRequests(requests);
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setLoadError(explain(err));
          setRequests(undefined);
        }
      });
    return () => controller.abort();
  }, [open, revision, reload]);

  async function review(
    request: StudentRequest,
    decision: 'approve' | 'decline',
    days?: number | null,
  ) {
    if (reviewing) return;
    setReviewing(true);
    setReviewError('');
    setNotice('');
    try {
      await courseApi('access-requests/' + encodeURIComponent(request.id) + '/review', {
        method: 'POST',
        body: JSON.stringify({ decision, validityDays: days }),
      });
      setRequests((current) => current?.filter((entry) => entry.id !== request.id));
      if (decision === 'approve') onApproved();
      setNotice(
        decision === 'approve'
          ? `${request.studentName} can now register with CPU number ${request.studentNumber}.`
          : `Declined the request from ${request.studentName}.`,
      );
    } catch (err) {
      setReviewError(explain(err));
    } finally {
      setReviewing(false);
      setReload((current) => current + 1);
    }
  }

  function approve(event: SubmitEvent<HTMLFormElement>, request: StudentRequest) {
    event.preventDefault();
    void review(request, 'approve', validityDays(new FormData(event.currentTarget)));
  }

  return (
    <details className="access-requests" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Student access requests</summary>
      {open && (
        <div className="account-directory">
          <button type="button" disabled={reviewing} onClick={() => setReload((n) => n + 1)}>
            Refresh requests
          </button>
          {loadError && (
            <p className="course-error" role="alert">
              {loadError}
            </p>
          )}
          {reviewError && (
            <p className="course-error" role="alert">
              {reviewError}
            </p>
          )}
          <output aria-live="polite">{notice}</output>
          {!requests && !loadError && <p role="status">Loading requests…</p>}
          {requests?.length === 0 && <p>No pending access requests.</p>}
          {requests && requests.length > 0 && (
            <ul aria-label="Student access requests">
              {requests.map((request) => (
                <li className="account-row" key={request.id}>
                  <strong>{request.studentName}</strong>
                  <p>
                    s{request.studentNumber}@cpu.edu.hk · S{request.yearOfStudy} ·{' '}
                    {request.phyTeamMember ? 'Physics Team member' : 'Non-member'}
                  </p>
                  {!request.phyTeamMember && (
                    <p className="request-reason">{request.justification}</p>
                  )}
                  <form className="account-editor" onSubmit={(event) => approve(event, request)}>
                    <ValidityField disabled={reviewing} />
                    <div className="account-actions">
                      <button className="primary" disabled={reviewing}>
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={reviewing}
                        onClick={() => void review(request, 'decline')}
                      >
                        Decline
                      </button>
                    </div>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </details>
  );
}
