function doGet(e) {
  return HtmlService.createHtmlOutputFromFile("index")
    .setTitle("🎈 TaskBoard")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag("viewport", "width=device-width, initial-scale=1.0, maximum-scale=1.0");
}

function saveTaskData(dataStr) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("data") || ss.insertSheet("data");
  sheet.getRange("A1").setValue(dataStr);
  sheet.getRange("B1").setValue(new Date().toISOString());
  return true;
}

function saveImageData(imageData) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("image");
  if (!sheet) sheet = ss.insertSheet("image");
  sheet.clearContents();
  var chunkSize = 40000;
  var chunks = [];
  for (var i = 0; i < imageData.length; i += chunkSize) {
    chunks.push([imageData.substring(i, i + chunkSize)]);
  }
  if (chunks.length > 0) sheet.getRange(1, 1, chunks.length, 1).setValues(chunks);
  sheet.getRange(chunks.length + 1, 1).setValue("__END__");
  return true;
}

function saveSketchData(taskNo, imageData) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetName = "sketch_" + taskNo;
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  sheet.clearContents();
  var chunkSize = 40000;
  var chunks = [];
  for (var i = 0; i < imageData.length; i += chunkSize) {
    chunks.push([imageData.substring(i, i + chunkSize)]);
  }
  if (chunks.length > 0) sheet.getRange(1, 1, chunks.length, 1).setValues(chunks);
  sheet.getRange(chunks.length + 1, 1).setValue("__END__");
  return true;
}

function getSketchData(taskNo) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("sketch_" + taskNo);
    if (!sheet) return null;
    var lastRow = sheet.getLastRow();
    if (lastRow === 0) return null;
    var values = sheet.getRange(1, 1, lastRow, 1).getValues();
    var result = "";
    for (var i = 0; i < values.length; i++) {
      var val = values[i][0];
      if (!val || val === "__END__") break;
      result += String(val);
    }
    return result || null;
  } catch(e) {
    return null;
  }
}

function deleteSketchData(taskNo) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("sketch_" + taskNo);
  if (sheet) sheet.clearContents();
  return true;
}

function getTaskData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("data");
  if (!sheet) return { data: null, image: null, updatedAt: null, sketchMap: {} };
  var data = String(sheet.getRange("A1").getValue() || "");
  var updatedAt = String(sheet.getRange("B1").getValue() || "");
  var image = getImageData_();
  var sketchMap = {};
  if (data.length > 10) {
    try {
      var parsed = JSON.parse(data);
      var tasks = parsed.tasks || [];
      tasks.forEach(function(task) {
        if (task.TaskNo) {
          var sketchSheet = ss.getSheetByName("sketch_" + task.TaskNo);
          sketchMap[task.TaskNo] = !!(sketchSheet && sketchSheet.getRange(1,1).getValue() !== "");
        }
      });
    } catch(e) {}
  }
  return {
    data: data.length > 10 ? data : null,
    image: image,
    updatedAt: updatedAt || null,
    sketchMap: sketchMap
  };
}

function getImageData_() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("image");
    if (!sheet) return null;
    var lastRow = sheet.getLastRow();
    if (lastRow === 0) return null;
    var values = sheet.getRange(1, 1, lastRow, 1).getValues();
    var result = "";
    for (var i = 0; i < values.length; i++) {
      var val = values[i][0];
      if (!val || val === "__END__") break;
      result += String(val);
    }
    return result || null;
  } catch(e) {
    return null;
  }
}

function resetTaskData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dataSheet = ss.getSheetByName("data");
  if (dataSheet) dataSheet.clearContents();
  var imageSheet = ss.getSheetByName("image");
  if (imageSheet) imageSheet.clearContents();
  var sheets = ss.getSheets();
  sheets.forEach(function(sheet) {
    if (sheet.getName().indexOf("sketch_") === 0) sheet.clearContents();
  });
  return true;
}
