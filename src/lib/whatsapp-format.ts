/**
 * WhatsApp Markdown post-processor.
 *
 * Converts standard LLM Markdown output to WhatsApp's limited dialect before
 * sending via TwiML. WhatsApp supports *bold*, _italic_, ~strikethrough~, and
 * monospace but does NOT support **bold**, [text](url), or headers.
 *
 * Rules applied (in order):
 *  1. **bold** / __bold__  →  *bold*   (non-greedy, no empty match)
 *  2. # / ## / ### headers at line start  →  *Header*
 *  3. [text](url)  →  text (url)
 *  4. Horizontal rules (--- or ***) on their own line  →  blank line
 *  5. 3+ consecutive blank lines  →  2 blank lines
 *
 * NOT touched: - lists, 1. lists, ```code```, _italic_, ~strikethrough~
 */
export function mdToWhatsApp(text: string): string {
  let out = text;

  // ── 1. **bold** / __bold__ → *bold*
  //
  // Pattern: match `**` or `__` then one-or-more non-asterisk/non-underscore
  // chars (non-greedy), then the matching closing marker.
  //
  // Using two separate replacements (one for ** and one for __) avoids
  // cross-contamination between the two markers.
  //
  // The inner group `[^*]+?` refuses to match an empty run and won't eat
  // across a second `**`, so `**foo**bar**baz**` becomes `*foo*bar*baz*`.
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, "*$1*");
  out = out.replace(/__([^_\n]+?)__/g, "*$1*");

  // ── 2. Markdown headers → *Header*
  //
  // Matches 1-3 `#` characters at the start of a line (multiline flag),
  // followed by optional space, then the rest of the line as the title.
  out = out.replace(/^#{1,3} *(.+)$/gm, "*$1*");

  // ── 3. [text](url) → text (url)
  //
  // Non-greedy match inside brackets and parens. Handles nested parens in
  // URLs poorly (rare in LLM output) but is sufficient for standard links.
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");

  // ── 4. Horizontal rules on their own line → blank line
  //
  // Matches lines that are exactly `---` or `***` (with optional surrounding
  // spaces), anchored at line boundaries.
  out = out.replace(/^ *(?:---|\*\*\*) *$/gm, "");

  // ── 5. Collapse 3+ consecutive blank lines to exactly 2
  out = out.replace(/\n{3,}/g, "\n\n");

  return out;
}
