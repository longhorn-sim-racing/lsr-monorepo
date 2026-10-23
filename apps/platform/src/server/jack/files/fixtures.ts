import { crc32 } from "node:zlib"
import ExcelJS from "exceljs"
import { deflateSync, strToU8, zipSync } from "fflate"
import { PDFDocument, StandardFonts } from "pdf-lib"
import sharp from "sharp"

/** Test helper: small real files of each kind, built in memory. Not used by the app */

const CONTENT_TYPES = (main: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${main}"/></Types>`

/** A Word document with these paragraphs; `extra` adds entries (a vbaProject.bin, say) */
export function docxFile(paragraphs: string[], extra: Record<string, Uint8Array> = {}): Buffer {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join("")
  return Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8(CONTENT_TYPES("application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml")),
      "_rels/.rels": strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
      ),
      "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`),
      ...extra,
    })
  )
}

/** An Excel workbook: one sheet per entry, rows of values (a `{ formula, result }` cell keeps its saved result) */
export async function xlsxFile(sheets: Record<string, ExcelJS.CellValue[][]>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  for (const [name, rows] of Object.entries(sheets)) {
    const sheet = workbook.addWorksheet(name)
    for (const row of rows) sheet.addRow(row)
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

/** A PDF with one page per text */
export async function pdfFile(pages: string[]): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const text of pages) {
    const page = pdf.addPage([600, 800])
    text.split("\n").forEach((line, i) => page.drawText(line, { x: 50, y: 700 - i * 20, size: 14, font }))
  }
  return Buffer.from(await pdf.save())
}

/** A solid-color image; `exif` adds camera and GPS-style metadata, `orientation` an EXIF rotation */
export async function imageFile(format: "png" | "jpeg" | "webp" | "gif", { width = 64, height = 48, orientation }: { width?: number; height?: number; orientation?: number } = {}): Promise<Buffer> {
  let image = sharp({ create: { width, height, channels: 3, background: "#bf5700" } })
  if (format === "jpeg") {
    image = image.withExif({ IFD0: { Make: "TestCam", Model: "Secret Model", ...(orientation ? { Orientation: String(orientation) } : {}) } })
    if (orientation) image = image.withMetadata({ orientation })
  }
  return image.toFormat(format).toBuffer()
}

/** A ZIP that inflates to `bytes` of zeros: the classic zip bomb, in miniature */
export function zipBomb(bytes: number, name = "word/document.xml"): Buffer {
  return Buffer.from(zipSync({ "[Content_Types].xml": strToU8("<Types/>"), [name]: new Uint8Array(bytes) }, { level: 9 }))
}

/** One ZIP entry written by hand (local header and data), with what its central record says */
export function localEntry(name: string, data: Uint8Array, deflate = false) {
  const body = deflate ? deflateSync(data) : data
  const nameBytes = Buffer.from(name)
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(deflate ? 8 : 0, 8)
  header.writeUInt32LE(crc32(data), 14)
  header.writeUInt32LE(body.length, 18)
  header.writeUInt32LE(data.length, 22)
  header.writeUInt16LE(nameBytes.length, 26)
  return { name, bytes: Buffer.concat([header, nameBytes, body]), method: deflate ? 8 : 0, crc: crc32(data), compressedSize: body.length, size: data.length }
}

export type LocalEntry = ReturnType<typeof localEntry>
export type CentralRecord = Pick<LocalEntry, "name" | "method" | "crc" | "compressedSize" | "size"> & { offset: number }

/**
 * A ZIP written by hand, for archives no normal tool writes: the entries back to back, then a central
 * directory of `records(offsets)` (by default one per entry, pointing at it), so a test can make the
 * central directory disagree with the local headers
 */
export function handZip(entries: LocalEntry[], records?: (offsets: number[]) => CentralRecord[]): Buffer {
  const offsets: number[] = []
  let at = 0
  for (const entry of entries) {
    offsets.push(at)
    at += entry.bytes.length
  }
  const central = (records ?? ((o) => entries.map((entry, i) => ({ ...entry, offset: o[i] }))))(offsets).map((record) => {
    const name = Buffer.from(record.name)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(record.method, 10)
    header.writeUInt32LE(record.crc, 16)
    header.writeUInt32LE(record.compressedSize, 20)
    header.writeUInt32LE(record.size, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt32LE(record.offset, 42)
    return Buffer.concat([header, name])
  })
  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(central.length, 8)
  end.writeUInt16LE(central.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(at, 16)
  return Buffer.concat([...entries.map((entry) => entry.bytes), centralBytes, end])
}
