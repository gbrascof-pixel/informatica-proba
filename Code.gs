const DEFAULT_SPREADSHEET_ID = '1SKKJLlED2lveMXjAYUtiAhTL8HZslWtIjxQG_uAWtTk'
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const COLUMN_ALIASES = {
  id: ['id', 'identificador', 'productid', 'referencia'],
  name: ['name', 'nom', 'nomdelproducte', 'item', 'producte', 'product'],
  barcode: ['barcode', 'codidebarres', 'ean'],
  size: ['size', 'talla'],
  stock: ['stock', 'estoc', 'quantitat'],
  imageUrl: ['imageurl', 'imatge', 'img'],
}

function doGet(event) {
  const parameters = event && event.parameter ? event.parameter : {}
  return dispatchRequest_(parameters.method || 'GET', parameters.path || '/api/health', null)
}

function doPost(event) {
  try {
    const payload = JSON.parse(event.postData.contents || '{}')
    return dispatchRequest_(payload.method || 'POST', payload.path || '', payload.body)
  } catch (error) {
    return response_(400, null, error.message || 'El cos de la sol·licitud no és JSON vàlid.')
  }
}

function dispatchRequest_(method, path, body) {
  try {
    const normalizedMethod = String(method || 'GET').toUpperCase()
    const route = String(path || '').replace(/^\/api(?=\/|$)/, '').replace(/\/+$/, '') || '/'

    if (normalizedMethod === 'GET' && route === '/health') {
      return response_(200, { status: 'ok' })
    }
    if (normalizedMethod === 'GET' && route === '/products') {
      return response_(200, { products: readProducts_() })
    }
    const imageRoute = route.match(/^\/images\/([^/]+)$/)
    if (normalizedMethod === 'GET' && imageRoute) {
      return response_(200, getDriveImage_(decodeURIComponent(imageRoute[1])))
    }
    if (normalizedMethod === 'POST' && route === '/products') {
      return response_(201, createProduct_(body))
    }
    if (normalizedMethod === 'PUT' && route === '/products/import') {
      return response_(200, { products: importProducts_(body && body.products) })
    }
    if (normalizedMethod === 'POST' && route === '/upload-image') {
      const upload = uploadImage_(body && body.file)
      return response_(upload.created ? 201 : 200, {
        imageUrl: upload.imageUrl,
        sharingWarning: upload.sharingWarning,
      })
    }

    const productRoute = route.match(/^\/products\/([^/]+)$/)
    if (productRoute && normalizedMethod === 'PUT') {
      return response_(200, updateProduct_(decodeURIComponent(productRoute[1]), body))
    }
    if (productRoute && normalizedMethod === 'DELETE') {
      return response_(200, deleteProduct_(decodeURIComponent(productRoute[1])))
    }

    const scanRoute = route.match(/^\/scan\/([^/]+)$/)
    if (scanRoute && normalizedMethod === 'POST') {
      return response_(200, scanBarcode_(decodeURIComponent(scanRoute[1])))
    }
    const undoScanRoute = route.match(/^\/undo-scan\/([^/]+)$/)
    if (undoScanRoute && normalizedMethod === 'POST') {
      return response_(200, adjustBarcodeStock_(decodeURIComponent(undoScanRoute[1]), 1))
    }

    return response_(404, null, 'No s’ha trobat la sol·licitud.')
  } catch (error) {
    return response_(error.status || 500, null, error.message || 'S’ha produït un error inesperat.')
  }
}

function response_(status, data, error) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: !error, status: status, data: data, error: error || undefined }))
    .setMimeType(ContentService.MimeType.JSON)
}

function getDriveImage_(fileId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(fileId)) throw httpError_(400, 'L’identificador de la imatge no és vàlid.')
  const folderId = PropertiesService.getScriptProperties().getProperty('GOOGLE_DRIVE_FOLDER_ID')
  if (!folderId) throw httpError_(500, 'Cal configurar GOOGLE_DRIVE_FOLDER_ID a les propietats de l’script.')

  let file
  try {
    file = DriveApp.getFileById(fileId)
  } catch (error) {
    throw httpError_(404, 'No s’ha trobat la imatge a Google Drive.')
  }
  const parents = file.getParents()
  let belongsToConfiguredFolder = false
  while (parents.hasNext()) {
    if (parents.next().getId() === folderId) {
      belongsToConfiguredFolder = true
      break
    }
  }
  if (!belongsToConfiguredFolder || file.isTrashed()) {
    throw httpError_(404, 'No s’ha trobat la imatge a la carpeta configurada.')
  }

  const blob = file.getBlob()
  const contentType = blob.getContentType()
  if (['image/jpeg', 'image/png', 'image/webp'].indexOf(contentType) < 0) {
    throw httpError_(415, 'El fitxer de Google Drive no és una imatge compatible.')
  }
  const bytes = blob.getBytes()
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw httpError_(413, 'La imatge no pot superar els 8 MB.')
  }
  return { contentType: contentType, data: Utilities.base64Encode(bytes) }
}

function withScriptLock_(operation) {
  const lock = LockService.getScriptLock()
  lock.waitLock(30000)
  try {
    return operation()
  } finally {
    lock.releaseLock()
  }
}

function withSheetLock_(operation) {
  return withScriptLock_(operation)
}

function getSheet_() {
  const properties = PropertiesService.getScriptProperties()
  const spreadsheetId = properties.getProperty('GOOGLE_SPREADSHEET_ID') || DEFAULT_SPREADSHEET_ID
  const sheetName = properties.getProperty('GOOGLE_SHEET_NAME') || ''
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId)
  const sheet = sheetName ? spreadsheet.getSheetByName(sheetName) : spreadsheet.getSheets()[0]
  if (!sheet) throw new Error('No s’ha trobat cap pestanya al full de Google Sheets.')
  ensureHeaders_(sheet)
  return sheet
}

function ensureHeaders_(sheet) {
  if (sheet.getLastRow() === 0 || sheet.getLastColumn() === 0) {
    sheet.getRange(1, 1, 1, 6).setValues([['id', 'item', 'talla', 'quantitat', 'codi de barres', 'img']])
    return
  }

  const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0]
  const columns = resolveColumns_(headerRow)
  const missing = []
  if (columns.id < 0) missing.push('id')
  if (columns.name < 0) missing.push('item')
  if (columns.size < 0) missing.push('talla')
  if (columns.stock < 0) missing.push('quantitat')
  if (columns.barcode < 0) missing.push('codi de barres')
  if (columns.imageUrl < 0) missing.push('img')
  if (missing.length) {
    sheet.getRange(1, headerRow.length + 1, 1, missing.length).setValues([missing])
  }
}

function resolveColumns_(headers) {
  const normalized = headers.map(normalizeHeader_)
  const result = {}
  Object.keys(COLUMN_ALIASES).forEach(function (field) {
    result[field] = normalized.findIndex(function (header) {
      return COLUMN_ALIASES[field].indexOf(header) >= 0
    })
  })
  return result
}

function normalizeHeader_(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

function readProducts_() {
  const sheet = getSheet_()
  const lastRow = sheet.getLastRow()
  if (lastRow < 2) return []

  const values = sheet.getRange(1, 1, lastRow, sheet.getLastColumn()).getDisplayValues()
  const headers = values.shift()
  const columns = resolveColumns_(headers)
  const required = ['id', 'name', 'size', 'stock']
  const missing = required.filter(function (field) { return columns[field] < 0 })
  if (missing.length) throw new Error('Falten columnes necessàries: ' + missing.join(', '))

  const byId = new Map()
  values.forEach(function (row, index) {
    if (row.every(function (value) { return String(value).trim() === '' })) return
    const line = index + 2
    const id = cell_(row, columns.id)
    const name = cell_(row, columns.name)
    if (!id || !name) throw new Error('La fila ' + line + ' necessita identificador i nom de producte.')
    const barcode = cell_(row, columns.barcode)
    const size = cell_(row, columns.size) || 'Única'
    const stockText = cell_(row, columns.stock)
    const stock = stockText === '' ? 0 : Number(stockText)
    if (barcode && !/^\d+$/.test(barcode)) throw new Error('El codi de barres de la fila ' + line + ' no és numèric.')
    if (!Number.isSafeInteger(stock) || stock < 0) throw new Error('L’estoc de la fila ' + line + ' ha de ser un enter igual o superior a zero.')

    const imageUrl = cell_(row, columns.imageUrl)
    let product = byId.get(id)
    if (product && product.name !== name) throw new Error('La referència "' + id + '" té més d’un nom de producte al full.')
    if (!product) {
      product = { id: id, name: name, variants: [] }
      byId.set(id, product)
    }
    if (imageUrl && !product.imageUrl) product.imageUrl = imageUrl
    product.variants.push(Object.assign({}, barcode ? { barcode: barcode } : {}, { size: size, stock: stock }))
  })

  const products = mergeProductsByName_(Array.from(byId.values()))
  if (!isValidProductList_(products)) throw new Error('El full conté identificadors o codis de barres duplicats, o productes no vàlids.')
  return products
}

function cell_(row, index) {
  return index < 0 ? '' : String(row[index] || '').trim()
}

function mergeProductsByName_(products) {
  const grouped = new Map()
  products.forEach(function (product) {
    const key = normalizeProductName_(product.name)
    const existing = grouped.get(key)
    if (!existing) {
      grouped.set(key, Object.assign({}, product, { variants: product.variants.slice() }))
    } else {
      if (!existing.imageUrl && product.imageUrl) existing.imageUrl = product.imageUrl
      existing.variants.push.apply(existing.variants, product.variants)
    }
  })
  return Array.from(grouped.values())
}

function normalizeProductName_(value) {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toLowerCase()
}

function isValidProduct_(product) {
  return Boolean(
    product
    && typeof product.id === 'string'
    && product.id.trim()
    && typeof product.name === 'string'
    && product.name.trim()
    && (product.imageUrl === undefined || (typeof product.imageUrl === 'string' && /^https?:\/\//i.test(product.imageUrl)))
    && Array.isArray(product.variants)
    && product.variants.length > 0
    && product.variants.every(function (variant) {
      return variant
        && (variant.barcode === undefined || (typeof variant.barcode === 'string' && /^\d+$/.test(variant.barcode)))
        && typeof variant.size === 'string'
        && variant.size.trim()
        && Number.isSafeInteger(variant.stock)
        && variant.stock >= 0
    })
  )
}

function isValidProductList_(products) {
  if (!Array.isArray(products) || !products.every(isValidProduct_)) return false
  if (new Set(products.map(function (product) { return product.id })).size !== products.length) return false
  const barcodes = []
  products.forEach(function (product) {
    product.variants.forEach(function (variant) {
      if (variant.barcode) barcodes.push(variant.barcode)
    })
  })
  return new Set(barcodes).size === barcodes.length
}

function writeProducts_(products) {
  const sheet = getSheet_()
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0]
  const columns = resolveColumns_(header)
  const lastRow = sheet.getLastRow()
  const dataColumns = ['id', 'name', 'size', 'stock', 'barcode', 'imageUrl'].filter(function (field) {
    return columns[field] >= 0
  })
  const existingRows = lastRow > 1
    ? sheet.getRange(2, 1, lastRow - 1, header.length).getDisplayValues()
    : []
  const existingRowsByBarcode = new Map()
  existingRows.forEach(function (row, index) {
    const barcode = cell_(row, columns.barcode)
    if (barcode) existingRowsByBarcode.set(barcode, { rowNumber: index + 2, row: row })
  })

  const rows = []
  const retainedRowNumbers = new Set()
  products.forEach(function (product) {
    product.variants.forEach(function (variant) {
      const existing = variant.barcode && existingRowsByBarcode.get(variant.barcode)
      const rowNumber = existing && !retainedRowNumbers.has(existing.rowNumber)
        ? existing.rowNumber
        : undefined
      if (rowNumber) retainedRowNumbers.add(rowNumber)
      rows.push({
        product: product,
        variant: variant,
        rowNumber: rowNumber,
        existingRow: existing && rowNumber ? existing.row : undefined,
      })
    })
  })

  let nextRowNumber = 2
  rows.forEach(function (row) {
    if (!row.rowNumber) {
      while (retainedRowNumbers.has(nextRowNumber)) nextRowNumber += 1
      row.rowNumber = nextRowNumber
      retainedRowNumbers.add(nextRowNumber)
      nextRowNumber += 1
    }
  })

  const lastWrittenRow = Math.max(lastRow, rows.reduce(function (last, row) {
    return Math.max(last, row.rowNumber)
  }, 1))
  const columnValues = {}
  dataColumns.forEach(function (field) {
    columnValues[field] = Array.from({ length: Math.max(0, lastWrittenRow - 1) }, function () { return [''] })
  })

  rows.forEach(function (entry) {
    const physicalId = String(entry.rowNumber - 1)
    const values = {
      id: physicalId,
      name: entry.product.name,
      size: entry.variant.size,
      stock: entry.variant.stock,
      barcode: physicalId.padStart(5, '0'),
      imageUrl: entry.product.imageUrl || '',
    }
    dataColumns.forEach(function (field) {
      columnValues[field][entry.rowNumber - 2] = [values[field]]
    })
  })

  dataColumns.forEach(function (field) {
    const column = columns[field]
    if (column >= 0 && columnValues[field].length) {
      if (field === 'barcode') sheet.getRange(2, column + 1, columnValues[field].length, 1).setNumberFormat('@')
      sheet.getRange(2, column + 1, columnValues[field].length, 1).setValues(columnValues[field])
    }
  })
}

function firstEmptyDataRow_(sheet) {
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0]
  const columns = resolveColumns_(header)
  const dataColumns = ['id', 'name', 'size', 'stock', 'barcode', 'imageUrl'].filter(function (field) {
    return columns[field] >= 0
  })
  const lastRow = sheet.getLastRow()
  const existingRows = lastRow > 1
    ? sheet.getRange(2, 1, lastRow - 1, header.length).getDisplayValues()
    : []

  for (let index = 0; index < existingRows.length; index += 1) {
    const isEmpty = dataColumns.every(function (field) {
      return !cell_(existingRows[index], columns[field])
    })
    if (isEmpty) return index + 2
  }
  return lastRow + 1
}

function createProduct_(product) {
  return withSheetLock_(function () {
    const current = readProducts_()
    if (!product || typeof product !== 'object') throw httpError_(400, 'Les dades del producte no són vàlides.')
    const firstRowId = String(firstEmptyDataRow_(getSheet_()) - 1)
    const productToSave = Object.assign({}, product, { id: firstRowId })
    if (!isValidProduct_(productToSave)) {
      console.error('Rejected invalid product payload.', {
        idPresent: Boolean(productToSave.id),
        namePresent: Boolean(productToSave.name && String(productToSave.name).trim()),
        imageUrlValid: productToSave.imageUrl === undefined || (typeof productToSave.imageUrl === 'string' && /^https?:\/\//i.test(productToSave.imageUrl)),
        variantsIsArray: Array.isArray(productToSave.variants),
        variantCount: Array.isArray(productToSave.variants) ? productToSave.variants.length : 0,
      })
      throw httpError_(400, 'Les dades del producte no són vàlides.')
    }
    if (current.some(function (item) { return item.id === productToSave.id })) {
      throw httpError_(409, 'Ja existeix un producte amb aquesta referència.')
    }
    const next = mergeProductsByName_(current.concat([productToSave]))
    if (!isValidProductList_(next)) throw httpError_(409, 'Un o més codis de barres ja estan assignats.')
    writeProducts_(next)
    const persisted = readProducts_()
    const merged = persisted.find(function (item) { return normalizeProductName_(item.name) === normalizeProductName_(productToSave.name) })
    return { product: merged, products: persisted }
  })
}

function importProducts_(products) {
  return withSheetLock_(function () {
    if (!isValidProductList_(products)) throw httpError_(400, 'La llista de productes importada no és vàlida.')
    const next = mergeProductsByName_(products)
    writeProducts_(next)
    return readProducts_()
  })
}

function updateProduct_(id, product) {
  return withSheetLock_(function () {
    if (!isValidProduct_(product) || product.id !== id) throw httpError_(400, 'Les dades del producte no són vàlides.')
    const current = readProducts_()
    const index = current.findIndex(function (item) { return item.id === id })
    if (index < 0) throw httpError_(404, 'No s’ha trobat el producte.')
    const next = mergeProductsByName_(current.map(function (item, itemIndex) { return itemIndex === index ? product : item }))
    if (!isValidProductList_(next)) throw httpError_(409, 'Un o més codis de barres ja estan assignats.')
    writeProducts_(next)
    const persisted = readProducts_()
    return {
      product: persisted.find(function (item) { return item.id === product.id })
        || persisted.find(function (item) { return normalizeProductName_(item.name) === normalizeProductName_(product.name) }),
      products: persisted,
    }
  })
}

function deleteProduct_(id) {
  return withSheetLock_(function () {
    const current = readProducts_()
    const deletedProduct = current.find(function (item) { return item.id === id })
    if (!deletedProduct) throw httpError_(404, 'No s’ha trobat el producte.')
    const persistedState = current.filter(function (item) { return item.id !== id })
    if (persistedState.length === current.length) throw httpError_(404, 'No s’han trobat les files del producte al full.')
    writeProducts_(persistedState)
    const persisted = readProducts_()
    const imageDeletionWarning = deletedProduct.imageUrl
      && !persisted.some(function (item) { return item.imageUrl === deletedProduct.imageUrl })
      ? trashUnusedDriveImage_(deletedProduct.imageUrl)
      : undefined
    return { products: persisted, imageDeletionWarning: imageDeletionWarning }
  })
}

function trashUnusedDriveImage_(imageUrl) {
  const match = String(imageUrl).match(/^https:\/\/drive\.google\.com\/(?:thumbnail|uc)\?[^#]*[?&]id=([^&#]+)/i)
  if (!match) return undefined
  const folderId = PropertiesService.getScriptProperties().getProperty('GOOGLE_DRIVE_FOLDER_ID')
  if (!folderId) return 'El artículo se eliminó, pero no se pudo borrar su imagen porque falta GOOGLE_DRIVE_FOLDER_ID.'
  try {
    const file = DriveApp.getFileById(decodeURIComponent(match[1]))
    const parents = file.getParents()
    let belongsToConfiguredFolder = false
    while (parents.hasNext()) {
      if (parents.next().getId() === folderId) {
        belongsToConfiguredFolder = true
        break
      }
    }
    if (!belongsToConfiguredFolder) return 'El artículo se eliminó; la imagen se conservó porque no pertenece a la carpeta de imágenes configurada.'
    file.setTrashed(true)
    return undefined
  } catch (error) {
    console.error('Product was deleted, but its unreferenced Drive image could not be trashed.', error)
    return 'El artículo se eliminó, pero no se pudo borrar la imagen de Drive. Puedes eliminarla manualmente si ya no se usa.'
  }
}

function scanBarcode_(barcode) {
  return adjustBarcodeStock_(barcode, -1)
}

function adjustBarcodeStock_(barcode, delta) {
  return withSheetLock_(function () {
    const current = readProducts_()
    const product = current.find(function (item) {
      return item.variants.some(function (variant) { return variant.barcode === barcode })
    })
    const variant = product && product.variants.find(function (item) { return item.barcode === barcode })
    if (!product || !variant) throw httpError_(404, 'No s’ha trobat cap producte amb aquest codi de barres.')
    if (delta < 0 && variant.stock < 1) throw httpError_(409, 'Aquesta variant no té estoc.')
    const updated = Object.assign({}, product, {
      variants: product.variants.map(function (item) {
        return item.barcode === barcode ? Object.assign({}, item, { stock: item.stock + delta }) : item
      }),
    })
    const next = current.map(function (item) { return item.id === product.id ? updated : item })
    writeProducts_(next)
    const persisted = readProducts_()
    const persistedProduct = persisted.find(function (item) {
      return item.variants.some(function (itemVariant) { return itemVariant.barcode === barcode })
    })
    const updatedVariant = persistedProduct && persistedProduct.variants.find(function (item) { return item.barcode === barcode })
    return { product: persistedProduct, variant: updatedVariant, stock: updatedVariant.stock }
  })
}

function authorizeDriveAccess() {
  const folderId = PropertiesService.getScriptProperties().getProperty('GOOGLE_DRIVE_FOLDER_ID')
  if (!folderId) throw new Error('Cal configurar GOOGLE_DRIVE_FOLDER_ID a les propietats de l’script.')
  const folder = DriveApp.getFolderById(folderId)
  const folderName = folder.getName()
  const testFile = folder.createFile(Utilities.newBlob(
    'Prova temporal de permisos de pujada.',
    'text/plain',
    'apps-script-drive-write-test.txt',
  ))
  testFile.setTrashed(true)
  return folderName
}

function uploadImage_(file) {
  if (!file || typeof file.name !== 'string' || typeof file.type !== 'string' || typeof file.data !== 'string') {
    throw httpError_(400, 'Cal seleccionar una imatge.')
  }
  if (['image/png', 'image/jpeg', 'image/webp'].indexOf(file.type) < 0) {
    throw httpError_(400, 'El format de la imatge ha de ser PNG, JPG o WEBP.')
  }
  const encoded = file.data.replace(/^data:[^,]*;base64,/, '')
  const bytes = Utilities.base64Decode(encoded)
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw httpError_(400, 'La imatge no pot superar els 8 MB.')
  if (!hasValidImageSignature_(bytes, file.type)) {
    throw httpError_(400, 'El contingut del fitxer no correspon a una imatge PNG, JPG o WEBP vàlida.')
  }

  const folderId = PropertiesService.getScriptProperties().getProperty('GOOGLE_DRIVE_FOLDER_ID')
  if (!folderId) throw httpError_(500, 'Cal configurar GOOGLE_DRIVE_FOLDER_ID a les propietats de l’script.')
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[file.type]
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
    .map(function (byte) { return unsignedByte_(byte).toString(16).padStart(2, '0') })
    .join('')
  const imageName = 'image-' + digest + '.' + extension
  return withScriptLock_(function () {
    const folder = DriveApp.getFolderById(folderId)
    const existingFiles = folder.getFilesByName(imageName)
    const exists = existingFiles.hasNext()
    const driveFile = exists ? existingFiles.next() : folder.createFile(Utilities.newBlob(bytes, file.type, imageName))
    let sharingWarning
    try {
      driveFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW)
    } catch (error) {
      console.error('Image was saved to Drive, but link sharing could not be updated.', error)
      sharingWarning = 'La imatge s’ha pujat a Drive, però Google no ha permès actualitzar-ne l’accés per enllaç. El producte es desarà igualment; comprova si els usuaris de l’app poden veure la imatge.'
    }
    return {
      imageUrl: 'https://drive.google.com/uc?export=view&id=' + encodeURIComponent(driveFile.getId()),
      created: !exists,
      sharingWarning: sharingWarning,
    }
  })
}

function hasValidImageSignature_(bytes, mimeType) {
  if (mimeType === 'image/png') {
    return bytes.length >= 8 && bytes.slice(0, 8).map(unsignedByte_).join(',') === '137,80,78,71,13,10,26,10'
  }
  if (mimeType === 'image/jpeg') {
    return bytes.length >= 3 && unsignedByte_(bytes[0]) === 255 && unsignedByte_(bytes[1]) === 216 && unsignedByte_(bytes[2]) === 255
  }
  return mimeType === 'image/webp'
    && bytes.length >= 12
    && bytes.slice(0, 4).map(function (byte) { return String.fromCharCode(unsignedByte_(byte)) }).join('') === 'RIFF'
    && bytes.slice(8, 12).map(function (byte) { return String.fromCharCode(unsignedByte_(byte)) }).join('') === 'WEBP'
}

function unsignedByte_(byte) {
  return byte & 0xff
}

function httpError_(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}
