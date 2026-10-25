/**
 * 文件的「带走」通道：下载成文件，或复制到剪贴板。
 *
 * 两条路都留着是有原因的：移动端浏览器对下载的处理差异很大（iOS 上会
 * 跳到另一个界面、部分内嵌浏览器直接吞掉），而复制到剪贴板几乎总能用，
 * 且对「贴进平台编辑器」这个最常见的去向来说更顺手。
 */

/** 把已经准备好的 URL 交给浏览器下载：a[download] 是各端唯一通用的入口 */
function triggerDownload(url: string, name: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  if (typeof URL.revokeObjectURL === 'function' && url.startsWith('blob:')) {
    // 立刻回收会让部分浏览器来不及开始下载，推到下一轮任务
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** 触发浏览器下载一个文本文件 */
export function saveTextFile(name: string, text: string, mime = 'text/plain;charset=utf-8'): void {
  /**
   * blob: URL 是首选（不受 URL 长度限制），但并非到处可用 ——
   * 部分内嵌浏览器禁用它，测试环境里的实现也可能不完整。
   * 失败就退回 data: URL，宁可多占一点内存也不要让导出整个失效。
   */
  let url: string;
  try {
    url = URL.createObjectURL(new Blob([text], { type: mime }));
  } catch {
    url = `data:${mime},${encodeURIComponent(text)}`;
  }
  triggerDownload(url, name);
}

/** 二进制内容的 data: URL 兜底：文本那套 encodeURIComponent 会把字节改写掉 */
function base64Of(bytes: Uint8Array): string {
  /**
   * 分块拼二进制字符串再 btoa。
   *
   * 一次性 `String.fromCharCode(...bytes)` 会在几十万字节时炸调用栈 ——
   * 分章导出的 zip 动辄上 MB，而这条兜底路径本来就是在「下载可能失败」时用的，
   * 不能在这里再赌一次。
   */
  const CHUNK = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

/** 触发浏览器下载一个二进制文件（如分章导出的 zip） */
export function saveBinaryFile(name: string, bytes: Uint8Array, mime: string): void {
  /**
   * 与 saveTextFile 同一套降级：先 blob，失败退回 data URL。
   * 二进制必须用 base64 变体，否则 data URL 里的字节会被当字符处理。
   */
  let url: string;
  try {
    url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
  } catch {
    url = `data:${mime};base64,${base64Of(bytes)}`;
  }
  triggerDownload(url, name);
}

/** 复制到剪贴板。返回是否成功，调用方据此给提示 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒或非安全上下文，走下面的兜底
  }

  /**
   * 兜底路径。
   *
   * 不只是为了老浏览器：`navigator.clipboard` 属于**安全上下文**专有 API，
   * 用手机通过局域网 IP（`http://192.168.x.x`）访问时它根本不存在，
   * 那时走到的就是这里。
   */
  try {
    const area = document.createElement('textarea');
    area.value = text;
    // 放在视口外而不是 display:none —— 后者无法选中
    area.style.position = 'fixed';
    area.style.opacity = '0';
    area.style.left = '-9999px';
    // iOS Safari 只肯选中「可编辑」的元素，readOnly 的会被跳过
    area.readOnly = false;
    area.contentEditable = 'true';
    document.body.appendChild(area);

    area.focus();
    area.select();
    // iOS 上 select() 常常无效，必须显式给出选区范围
    area.setSelectionRange?.(0, text.length);

    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 读取用户选择的文件内容 */
export function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsText(file);
  });
}
