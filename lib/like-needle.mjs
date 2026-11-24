// A folder or path piece for LIKE. The characters the person typed are characters.
export function likeNeedle(value) {
  return String(value).replace(/[\\%_]/g, (ch) => "\\" + ch);
}
export function folderPattern(folder) {
  return likeNeedle(String(folder).replace(/\/?$/, "/"));
}
