// Install in a standalone Apps Script project owned by the classroom's sender.
function doPost(event) {
  const settings = PropertiesService.getScriptProperties();
  const secret = settings.getProperty('GOOGLE_MAIL_SECRET');
  const testRecipient = settings.getProperty('MAIL_TEST_RECIPIENT');
  const input = JSON.parse(event.postData.contents);
  if (!secret || secret.length < 32 || input.secret !== secret ||
      typeof input.email !== 'string' || !input.email ||
      (!/^s[0-9]{7}@cpu\.edu\.hk$/.test(input.email) && input.email !== testRecipient) ||
      input.subject !== 'Reset your CPU Physics Olympiad classroom password' ||
      typeof input.text !== 'string' || input.text.length > 1500) {
    return ContentService.createTextOutput('rejected');
  }
  MailApp.sendEmail({to: input.email, subject: input.subject, body: input.text, name: 'CPU Physics Olympiad'});
  return ContentService.createTextOutput('sent');
}
