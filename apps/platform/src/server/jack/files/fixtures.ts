import ExcelJS from "exceljs"
import { strToU8, zipSync } from "fflate"
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
