/**
 * Changed markers + photo — standalone script
 * ------------------------------------------------------------------
 * When a person edits a row on the "Customer Order Details" tab:
 *   column L  -> the word "changed"
 *   column M  -> date/time of the change
 *   column N  -> link to the photo of the person (when photos are switched on)
 *
 * Columns L:N are LOCKED: staff can see them but cannot edit them. Only the
 * owner (you) and the ordering app's own Google account can write there, so
 * the app's manual orders / add-ons / customer orders keep working.
 * Everything else on the sheet stays editable by everyone it is shared with.
 *
 * Photos are saved in the Drive folder "Sheet Change Photos" which is set to
 * "anyone with the link can VIEW", so nobody has to ask for permission to see
 * a photo. (Viewing only — nobody can change or delete them.)
 *
 * The photo feature is switched by PHOTO_ENABLED below (true = on).
 */

var CHANGED_TZ = 'Africa/Johannesburg';
var CHANGED_COL = 12;      // L: the word "changed"
var CHANGED_AT_COL = 13;   // M: date/time of the change
var PHOTO_COL = 14;        // N: link to the photo
var DATA_LAST_COL = 11;    // K: last order-data column
var ORDER_TAB_NAME = 'Customer Order Details';
var PROTECT_DESC = 'Auto-filled by the system — please do not delete';

// The two order tabs. Edits on any other tab are ignored.
var ORDER_TAB_GIDS = [1049158606, 1026895194];

// Secret token the /camera page must send. Paste this same value into the
// camera page settings. (Change it here + in the camera page if it ever leaks.)
// Photo feature switch. true = photos ON, false = PAUSED (no photo requests are queued).
var PHOTO_ENABLED = true;

var CAMERA_TOKEN = 'bcfe967bcbeaabe8ff8e4339b57a91d2';

var QUEUE_TAB = '__photo_queue';
var PHOTO_FOLDER_NAME = 'Sheet Change Photos';
var MERGE_WINDOW_MS = 15 * 1000;     // edits within 15s share one photo
var MAX_AGE_MS = 5 * 60 * 1000;      // an edit older than 5 min is no longer photographed
var KEEP_QUEUE_MS = 24 * 60 * 60 * 1000;
var MAX_IMAGE_CHARS = 6 * 1024 * 1024; // refuse absurdly large uploads

// Queue columns (1-based): A id | B createdMs | C gid | D rows | E editor | F status | G claimedMs
var Q_ID = 1, Q_CREATED = 2, Q_GID = 3, Q_ROWS = 4, Q_EDITOR = 5, Q_STATUS = 6, Q_CLAIMED = 7;

// ============================== SETUP ==============================

/** Run ONCE per spreadsheet. Safe to run again. */
function setupChangedMarkers() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(ORDER_TAB_NAME);
  if (!sheet) {
    throw new Error('Could not find the "' + ORDER_TAB_NAME + '" tab in this spreadsheet. Run this in the MON-WED / THU-SAT order sheet project.');
  }

  // Headers
  sheet.getRange(1, CHANGED_COL).setValue('Changed');
  sheet.getRange(1, CHANGED_AT_COL).setValue('Changed At');
  sheet.getRange(1, PHOTO_COL).setValue('Photo');

  // Lock L:N for staff (owner + the app's account stay allowed).
  sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) {
    if (p.getDescription() === PROTECT_DESC) p.remove();
  });
  var lastRow = Math.max(2000, sheet.getMaxRows());
  var protection = sheet.getRange(1, CHANGED_COL, lastRow, 3).protect();
  protection.setDescription(PROTECT_DESC);
  protection.setWarningOnly(false);
  applyProtectionEditors_(protection);
  Logger.log('Locked columns L:N (staff can view but not edit; you and the app can).');

  if (PHOTO_ENABLED) {
    // Hidden queue tab
    var q = ss.getSheetByName(QUEUE_TAB);
    if (!q) {
      q = ss.insertSheet(QUEUE_TAB);
      q.appendRow(['id', 'createdMs', 'gid', 'rows', 'editor', 'status', 'claimedMs']);
    }
    q.hideSheet();

    // Drive folder for the photos (viewable by link)
    getPhotoFolder_();

    // Secret token for the camera page
    PropertiesService.getScriptProperties().setProperty('PHOTO_TOKEN', CAMERA_TOKEN);
  }

  // Edit trigger (runs as the owner, for every editor)
  var has = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'markChangedOnEdit';
  });
  if (!has) {
    ScriptApp.newTrigger('markChangedOnEdit').forSpreadsheet(ss).onEdit().create();
    Logger.log('Edit trigger installed: markChangedOnEdit.');
  } else {
    Logger.log('Edit trigger already installed.');
  }

  Logger.log('Done. Changed markers are ON; L:N locked for staff; photos are ' + (PHOTO_ENABLED ? 'ON.' : 'PAUSED.'));
}

/**
 * Keeps ONLY these accounts able to edit L:N:
 *   - the spreadsheet OWNER (whoever really owns the file)
 *   - the person running this script
 *   - every address in ALWAYS_ALLOWED below (add your other Google accounts here)
 *   - the ordering app's own Google account (an address ending in gserviceaccount.com)
 * Everyone else is removed.
 */
var ALWAYS_ALLOWED = ['portugalbakery01@gmail.com', 'jonathankabango08@gmail.com'];

function applyProtectionEditors_(protection) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var allowed = {};
  function allow(mail) { if (mail) allowed[String(mail).toLowerCase()] = true; }
  allow(Session.getEffectiveUser().getEmail());
  try { var owner = ss.getOwner(); if (owner) allow(owner.getEmail()); } catch (err) { /* shared drive: no owner */ }
  ALWAYS_ALLOWED.forEach(allow);

  var isApp = function (mail) { return /gserviceaccount\.com$/i.test(mail); };
  var kept = {};

  // 1) Remove everyone who is not allowed.
  protection.getEditors().forEach(function (u) {
    var mail = u.getEmail();
    if (allowed[mail.toLowerCase()] || isApp(mail)) kept[mail.toLowerCase()] = true;
    else { try { protection.removeEditor(u); } catch (err) { Logger.log('Could not remove ' + mail + ': ' + err); } }
  });

  // 2) Add every allowed person / the app account who is missing.
  var toAdd = Object.keys(allowed);
  ss.getEditors().forEach(function (u) { if (isApp(u.getEmail())) toAdd.push(u.getEmail()); });
  toAdd.forEach(function (mail) {
    if (kept[mail.toLowerCase()]) return;
    try { protection.addEditor(mail); kept[mail.toLowerCase()] = true; }
    catch (err) { Logger.log('Could not add ' + mail + ' (is the sheet shared with them as Editor?): ' + err); }
  });

  var list = Object.keys(kept);
  Logger.log('Allowed to edit L:N: ' + list.join(', '));
  if (!list.some(isApp)) {
    Logger.log('WARNING: the app\'s service account (…@…gserviceaccount.com) is not an editor of this spreadsheet. ' +
      'Share the sheet with it as Editor, then run fixProtectionForApp.');
  }
}

/** RUN THIS if the app ever says "protected cell": re-allows the app's account. */
function fixProtectionForApp() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ORDER_TAB_NAME);
  if (!sheet) throw new Error('Tab "' + ORDER_TAB_NAME + '" not found.');
  var found = 0;
  sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) {
    if (p.getDescription() === PROTECT_DESC) { applyProtectionEditors_(p); found++; }
  });
  if (!found) Logger.log('No L:N lock found — run setupChangedMarkers instead.');
}

/**
 * Makes the photo folder and every photo in it viewable by anyone with the
 * link (view only). Run once; new photos are set automatically.
 */
function makePhotosViewable() {
  var folder = getPhotoFolder_();
  setViewable_(folder);
  var files = folder.getFiles();
  var n = 0;
  while (files.hasNext()) { setViewable_(files.next()); n++; }
  Logger.log('Photos folder + ' + n + ' photo(s) are now viewable by anyone with the link: ' + folder.getUrl());
}

function setViewable_(item) {
  try { item.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }
  catch (err) { Logger.log('Could not set sharing on ' + item.getName() + ': ' + err); }
}

/** Run any time to see the token again. */
function showPhotoToken() {
  Logger.log('SECRET TOKEN: ' + PropertiesService.getScriptProperties().getProperty('PHOTO_TOKEN'));
}

function getPhotoFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('PHOTO_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (err) { /* recreate below */ }
  }
  var folder = DriveApp.createFolder(PHOTO_FOLDER_NAME);
  setViewable_(folder);
  props.setProperty('PHOTO_FOLDER_ID', folder.getId());
  return folder;
}

// ============================ EDIT TRIGGER ============================

/**
 * Installable onEdit trigger: stamps "changed" + time on every edited row
 * that has order data, then queues a photo request for the camera page.
 * Programmatic writes (the app, the daily clear) don't fire this trigger.
 */
function markChangedOnEdit(e) {
  if (!e || !e.range) return;
  var sheet = e.range.getSheet();
  if (ORDER_TAB_GIDS.indexOf(sheet.getSheetId()) === -1) return;

  var startRow = e.range.getRow();
  var endRow = startRow + e.range.getNumRows() - 1;
  var startCol = e.range.getColumn();
  var endCol = startCol + e.range.getNumColumns() - 1;

  var touchesData = startCol <= DATA_LAST_COL;
  var touchesMarkers = endCol >= CHANGED_COL && startCol <= PHOTO_COL;
  if (!touchesData && !touchesMarkers) return;

  var firstRow = Math.max(startRow, 2); // never stamp the header row
  if (firstRow > endRow) return;
  var numRows = endRow - firstRow + 1;

  var data = sheet.getRange(firstRow, 1, numRows, DATA_LAST_COL).getValues();
  var stamp = Utilities.formatDate(new Date(), CHANGED_TZ, 'dd/MM/yyyy HH:mm');

  var runs = [];
  var runStart = null, runEnd = null;
  var stampedRows = [];
  for (var i = 0; i < numRows; i++) {
    var hasData = data[i].some(function (v) { return v !== '' && v !== null; });
    var r = firstRow + i;
    if (hasData) {
      stampedRows.push(r);
      if (runStart === null) { runStart = r; runEnd = r; }
      else if (r === runEnd + 1) { runEnd = r; }
      else { runs.push([runStart, runEnd]); runStart = r; runEnd = r; }
    }
  }
  if (runStart !== null) runs.push([runStart, runEnd]);

  runs.forEach(function (run) {
    var n = run[1] - run[0] + 1;
    var changedVals = [], timeVals = [];
    for (var k = 0; k < n; k++) { changedVals.push(['changed']); timeVals.push([stamp]); }
    sheet.getRange(run[0], CHANGED_COL, n, 1).setValues(changedVals);
    sheet.getRange(run[0], CHANGED_AT_COL, n, 1).setValues(timeVals);
  });

  // (PAUSED unless PHOTO_ENABLED) Ask for a photo of whoever just made this change (cap rows per request).
  if (PHOTO_ENABLED && stampedRows.length > 0) {
    var editor = '';
    try { editor = (e.user && e.user.getEmail()) || ''; } catch (err) { editor = ''; }
    try {
      queuePhoto_(sheet.getSheetId(), stampedRows.slice(0, 200), editor);
    } catch (err) {
      Logger.log('queuePhoto_ failed: ' + err);
    }
  }
}

// =============================== QUEUE ================================

function getQueueSheet_() {
  var q = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(QUEUE_TAB);
  if (!q) throw new Error('Queue tab missing — run setupChangedMarkers once.');
  return q;
}

function queuePhoto_(gid, rows, editor) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var q = getQueueSheet_();
    var now = Date.now();
    var last = q.getLastRow();

    // Housekeeping: drop rows older than a day (keeps the queue tiny).
    if (last >= 2) {
      var all = q.getRange(2, 1, last - 1, 7).getValues();
      var keep = all.filter(function (r) { return now - Number(r[Q_CREATED - 1]) < KEEP_QUEUE_MS; });
      if (keep.length !== all.length) {
        q.getRange(2, 1, last - 1, 7).clearContent();
        if (keep.length) q.getRange(2, 1, keep.length, 7).setValues(keep);
        last = 1 + keep.length;
      }
    }

    // Merge into the newest pending request if it's very recent (same person,
    // same tab) — a burst of edits shares one photo instead of dozens.
    if (last >= 2) {
      var rec = q.getRange(last, 1, 1, 7).getValues()[0];
      var sameTab = Number(rec[Q_GID - 1]) === gid;
      var sameEditor = String(rec[Q_EDITOR - 1]) === editor;
      var fresh = now - Number(rec[Q_CREATED - 1]) <= MERGE_WINDOW_MS;
      if (rec[Q_STATUS - 1] === 'pending' && sameTab && sameEditor && fresh) {
        var set = {};
        String(rec[Q_ROWS - 1]).split(',').forEach(function (x) { if (x) set[x] = true; });
        rows.forEach(function (x) { set[String(x)] = true; });
        q.getRange(last, Q_ROWS).setValue(Object.keys(set).join(','));
        return;
      }
    }

    q.appendRow([Utilities.getUuid(), now, gid, rows.join(','), editor, 'pending', '']);
  } finally {
    lock.releaseLock();
  }
}

// ============================ WEB ENDPOINT ============================

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function tokenOk_(t) {
  var real = PropertiesService.getScriptProperties().getProperty('PHOTO_TOKEN');
  return !!real && !!t && String(t) === real;
}

/** GET ?action=ping|take&token=...&email=... */
function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (!tokenOk_(p.token)) return json_({ ok: false, error: 'bad token' });
    if (p.action === 'ping') return json_({ ok: true, pong: true });
    if (p.action === 'take') return json_({ ok: true, item: takeNext_(String(p.email || '')) });
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/** POST (text/plain JSON) {action:'upload', token, id, image} */
function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!tokenOk_(body.token)) return json_({ ok: false, error: 'bad token' });
    if (body.action === 'upload') return json_(saveUpload_(body));
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/** Hands the oldest still-fresh pending request to the camera page. */
function takeNext_(email) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var q = getQueueSheet_();
    var last = q.getLastRow();
    if (last < 2) return null;
    var now = Date.now();
    var recs = q.getRange(2, 1, last - 1, 7).getValues();
    var mail = email.toLowerCase();
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i];
      if (r[Q_STATUS - 1] !== 'pending') continue;
      var age = now - Number(r[Q_CREATED - 1]);
      if (age > MAX_AGE_MS) {
        q.getRange(i + 2, Q_STATUS).setValue('expired');
        continue;
      }
      // Give a request only to the matching person's camera when we know both.
      var editor = String(r[Q_EDITOR - 1]).toLowerCase();
      if (mail && editor && mail !== editor) continue;
      // Short pause so the edit has settled (and quick follow-up edits can join it).
      if (age < 3000) continue;
      q.getRange(i + 2, Q_STATUS).setValue('claimed');
      q.getRange(i + 2, Q_CLAIMED).setValue(now);
      return {
        id: String(r[Q_ID - 1]),
        gid: Number(r[Q_GID - 1]),
        rows: String(r[Q_ROWS - 1]).split(',').filter(String).map(Number)
      };
    }
    return null;
  } finally {
    lock.releaseLock();
  }
}

/** Saves the photo to Drive and writes the link in column N of the rows. */
function saveUpload_(body) {
  var id = String(body.id || '');
  var image = String(body.image || '');
  if (!id || !image) return { ok: false, error: 'missing id/image' };
  if (image.length > MAX_IMAGE_CHARS) return { ok: false, error: 'image too large' };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  var rec = null, rowIndex = -1, q;
  try {
    q = getQueueSheet_();
    var last = q.getLastRow();
    if (last < 2) return { ok: false, error: 'queue empty' };
    var recs = q.getRange(2, 1, last - 1, 7).getValues();
    for (var i = 0; i < recs.length; i++) {
      if (String(recs[i][Q_ID - 1]) === id) { rec = recs[i]; rowIndex = i + 2; break; }
    }
    if (!rec) return { ok: false, error: 'unknown request' };
    if (rec[Q_STATUS - 1] !== 'claimed') return { ok: false, error: 'request not claimed (' + rec[Q_STATUS - 1] + ')' };
    q.getRange(rowIndex, Q_STATUS).setValue('saving');
  } finally {
    lock.releaseLock();
  }

  try {
    var b64 = image.replace(/^data:image\/[a-zA-Z+]+;base64,/, '');
    var editor = String(rec[Q_EDITOR - 1]) || 'unknown';
    var when = Utilities.formatDate(new Date(), CHANGED_TZ, 'yyyy-MM-dd HH-mm-ss');
    var blob = Utilities.newBlob(Utilities.base64Decode(b64), 'image/jpeg', 'change ' + when + ' - ' + editor + '.jpg');
    var file = getPhotoFolder_().createFile(blob);
    setViewable_(file); // anyone with the link can VIEW (not edit)
    var url = 'https://drive.google.com/file/d/' + file.getId() + '/view';

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var gid = Number(rec[Q_GID - 1]);
    var sheet = ss.getSheets().filter(function (s) { return s.getSheetId() === gid; })[0];
    if (sheet) {
      String(rec[Q_ROWS - 1]).split(',').filter(String).forEach(function (r) {
        sheet.getRange(Number(r), PHOTO_COL).setFormula('=HYPERLINK("' + url + '","📷 photo")');
      });
    }
    q.getRange(rowIndex, Q_STATUS).setValue('done');
    return { ok: true, url: url };
  } catch (err) {
    q.getRange(rowIndex, Q_STATUS).setValue('failed');
    return { ok: false, error: String(err) };
  }
}
