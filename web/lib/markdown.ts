// Minimal Markdown → HTML for job descriptions that arrive as Markdown or
// plain text (Bundesagentur Jobsuche). Covers what those postings use:
// headings, bold/italic, links, bullet and numbered lists, paragraphs.
// The output is still untrusted — callers must run it through the sanitizer.

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inline(text: string): string {
  // Backslash-escaped punctuation (e.g. "Camper\*innen") must not be read as
  // emphasis: park it as a numeric entity, which the patterns below ignore.
  let s = escapeHtml(text).replace(/\\([\\`*_{}[\]()#+\-.!~|])/g, (_m, c: string) => `&#${c.charCodeAt(0)};`);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, "$1<em>$2</em>");
  return s;
}

export function markdownToHtml(markdown: string): string {
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;

  const flush = () => {
    if (paragraph.length) {
      out.push(`<p>${paragraph.join("<br>")}</p>`);
      paragraph = [];
    }
    if (list) {
      out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`);
      list = null;
    }
  };

  for (const rawLine of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      // Descriptions sit under the page's h1; keep their headings below it.
      const level = Math.min(heading[1].length + 1, 4);
      out.push(`<h${level}>${inline(heading[2].replace(/\s+#+$/, ""))}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^[-*•·]\s+(.*)$/);
    const numbered = line.match(/^\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const tag = bullet ? "ul" : "ol";
      if (paragraph.length || (list && list.tag !== tag)) flush();
      list ??= { tag, items: [] };
      list.items.push(inline((bullet ?? numbered)![1]));
      continue;
    }
    if (list) flush();
    paragraph.push(inline(line));
  }
  flush();
  return out.join("\n");
}
