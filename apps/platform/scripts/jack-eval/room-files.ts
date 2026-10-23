/**
 * Files in an eval question's room (G6): the asking officer posts them the way the room does, through
 * the real code: an upload (createUpload), the bytes where its link points, registration (the checks,
 * photo copies, text, and Claude Files when that's switched on), then a message they're posted with.
 * The question's own message, built in memory by runCase, carries every file posted in its room, so the
 * reply sees them as files attached to the question. The room's cleanup deletes them with their stored
 * copies and their copies on Claude Files.
 *
 * Only fake data goes in: the repo is public, and the eval's results keep what the reply said.
 */
import type { GuardContext } from "./shared";

export type EvalFile = { name: string; bytes: Buffer };

/** Posts the files in the question's room, as its officer; their ids, in order */
export async function postEvalFiles(ctx: GuardContext, files: EvalFile[]): Promise<string[]> {
  const [{ createUpload }, { registerFile }, { jackFileStore }] = await Promise.all([
    import("../../src/server/jack/files/service"),
    import("../../src/server/jack/files/register"),
    import("../../src/server/jack/decks/storage"),
  ]);
  const store = jackFileStore();
  const ids: string[] = [];
  for (const file of files) {
    const ticket = await createUpload(ctx.officer.id, { roomId: ctx.roomId, filename: file.name, size: file.bytes.length, type: "" }, store);
    if (!ticket.ok) throw new Error(`Couldn't attach ${file.name}: ${ticket.error}`);
    const { storagePath } = await ctx.prisma.jackFile.findUniqueOrThrow({ where: { id: ticket.data.file.id }, select: { storagePath: true } });
    await store.put(storagePath, file.bytes, ticket.data.contentType);
    const registered = await registerFile(ticket.data.file.id, ctx.officer.id, store);
    if (!registered.ok) throw new Error(`Couldn't register ${file.name}: ${registered.error}`);
    ids.push(ticket.data.file.id);
  }
  // Posted with a message of their own (room_files lists posted files only); nothing ever answers it
  const message = await ctx.prisma.jackMessage.create({ data: { roomId: ctx.roomId, kind: "user", authorUserId: ctx.officer.id, content: "" } });
  for (const [position, id] of ids.entries()) await ctx.prisma.jackFile.update({ where: { id }, data: { messageId: message.id, position } });
  return ids;
}

/** A small CSV of practice laps with made-up drivers */
export function practiceLapsCsv(): EvalFile {
  const rows = [
    ["driver", "track", "best_lap", "laps"],
    ["Rowan Test", "Road Atlanta", "1:24.512", "14"],
    ["Sam Placeholder", "Road Atlanta", "1:23.907", "11"],
    ["Jordan Sample", "Road Atlanta", "1:25.130", "9"],
  ];
  return { name: "practice-laps.csv", bytes: Buffer.from(rows.map((row) => row.join(",")).join("\n")) };
}

/** A PDF with these lines on one page (Helvetica, so plain ASCII), long lines wrapped to fit */
export async function textPdf(name: string, lines: string[]): Promise<EvalFile> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  lines.flatMap((line) => wrap(line, 85)).forEach((line, i) => page.drawText(line, { x: 48, y: 740 - i * 18, size: 11, font }));
  return { name, bytes: Buffer.from(await pdf.save()) };
}

function wrap(line: string, width: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const word of line.split(" ")) {
    if (current && `${current} ${word}`.length > width) {
      out.push(current);
      current = word;
    } else current = current ? `${current} ${word}` : word;
  }
  return [...out, current];
}

/** A photo-sized JPEG: a dark track with an orange car shape, so a slide has something to frame */
export async function trackPhoto(): Promise<EvalFile> {
  const { default: sharp } = await import("sharp");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000">
<rect width="1600" height="1000" fill="#1b1b1b"/>
<path d="M0 700 C 400 560 1200 560 1600 700 L1600 1000 L0 1000 Z" fill="#2c2c2c"/>
<rect x="560" y="560" width="480" height="120" rx="40" fill="#ff8000"/>
<circle cx="660" cy="690" r="46" fill="#0b0b0b"/><circle cx="940" cy="690" r="46" fill="#0b0b0b"/>
</svg>`;
  return { name: "lounge-car.jpg", bytes: await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer() };
}
