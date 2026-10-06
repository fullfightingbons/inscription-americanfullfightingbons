// Fixtures partagées par les tests d'images (ce fichier n'est pas un test : il ne se termine pas par .test.mjs).

// Mini-images réelles (JPEG 40×20 sans EXIF, PNG 30×10 avec transparence).
export const JPEG_40x20_B64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAUACgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDmaKKK8g/RAooooAKKKKACiiigAooooAKKKKAP/9k=";
export const PNG_30x10_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAB4AAAAKCAYAAACjd+4vAAAAHUlEQVR4nGNkYPjfwDAAgGkgLB21eNTiUYuHh8UAQbABk075dRoAAAAASUVORK5CYII=";

export const jpegBytes = () => new Uint8Array(Buffer.from(JPEG_40x20_B64, "base64"));
export const pngBytes = () => new Uint8Array(Buffer.from(PNG_30x10_B64, "base64"));

/** Insère un segment EXIF (orientation donnée) juste après le SOI d'un JPEG. */
export function withExifOrientation(jpeg, orientation, { bigEndian = false } = {}) {
  const tiff = bigEndian
    ? [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8,  0x00, 0x01,  0x01, 0x12, 0x00, 0x03, 0, 0, 0, 1, 0x00, orientation, 0, 0,  0, 0, 0, 0]
    : [0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0,  0x01, 0x00,  0x12, 0x01, 0x03, 0x00, 1, 0, 0, 0, orientation, 0, 0, 0,  0, 0, 0, 0];
  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  const length = payload.length + 2;
  const segment = [0xff, 0xe1, (length >> 8) & 0xff, length & 0xff, ...payload];
  return new Uint8Array([...jpeg.slice(0, 2), ...segment, ...jpeg.slice(2)]);
}
