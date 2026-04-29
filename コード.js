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

function getTaskData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("data");
  if (!sheet) return { data: null, image: null, updatedAt: null };
  var data = String(sheet.getRange("A1").getValue() || "");
  var updatedAt = String(sheet.getRange("B1").getValue() || "");
  var image = getImageData_();
  return {
    data: data.length > 10 ? data : null,
    image: image,
    updatedAt: updatedAt || null
  };
}

function getImageData_() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("image");
    if (!sheet) return null;
    var result = "";
    var row = 1;
    while (row <= 100) {
      var val = sheet.getRange(row, 1).getValue();
      if (!val || val === "__END__") break;
      result += String(val);
      row++;
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
  return true;
  
}

//Test VS CODE
