/**
 * Open access — standalone script
 * ------------------------------------------------------------------
 * Makes BOTH order spreadsheets editable by anyone who has the link.
 * Nobody needs to request access or be added one by one.
 *
 * HOW TO USE (once, from the Google account that OWNS the sheets):
 *   1. In either sheet: Extensions -> Apps Script -> "+" next to Files ->
 *      Script -> name it  access  -> paste this whole file -> Save.
 *   2. Choose  openAccessForEveryone  in the function dropdown -> Run.
 *   3. Click "Review permissions" -> choose your account -> Advanced ->
 *      Go to project (unsafe) -> Allow. (It needs Drive access to change sharing.)
 *   4. Open the Execution log: it should say "OK ... ANYONE_WITH_LINK / EDIT" twice.
 */

var ORDER_SHEET_IDS = [
  '137ZxSSgodwcOOUpItZyZplMpwn3QXL8DvdneqQowJ98', // MON-WED
  '1PvpM6Be4xOCa_GqMYEg7-9M1BwcT1kfznwOxLRImEAw'  // THU-SAT
];

function openAccessForEveryone() {
  ORDER_SHEET_IDS.forEach(function (id) {
    try {
      var file = DriveApp.getFileById(id);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.EDIT);
      Logger.log('OK  ' + file.getName() + ' -> ' + file.getSharingAccess() + ' / ' + file.getSharingPermission());
    } catch (err) {
      Logger.log('FAILED for ' + id + ': ' + err +
        '  (run this from the account that owns the sheet, or open the sheet -> Share -> General access -> Anyone with the link -> Editor)');
    }
  });

  // Report (does not delete) any other locks that could still stop people editing.
  ORDER_SHEET_IDS.forEach(function (id) {
    try {
      var ss = SpreadsheetApp.openById(id);
      ss.getSheets().forEach(function (sh) {
        sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) {
          if (!p.isWarningOnly()) Logger.log('LOCK on "' + sh.getName() + '" range ' + p.getRange().getA1Notation() + ' (' + p.getDescription() + ')');
        });
        var sp = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET)[0];
        if (sp && !sp.isWarningOnly()) Logger.log('LOCK on whole tab "' + sh.getName() + '"');
      });
    } catch (err) { Logger.log('Could not inspect ' + id + ': ' + err); }
  });
  Logger.log('Done.');
}
