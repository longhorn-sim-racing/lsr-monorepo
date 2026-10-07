import QRCode from 'qrcode';

export async function generateQrCodeDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, {
      margin: 2,
      scale: 10,
      color: {
          dark: '#000000',
          light: '#ffffff',
      }
  });
}
