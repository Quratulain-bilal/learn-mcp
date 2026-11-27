/**
 * Splitting a policy document into PASSAGES: one passage per numbered rule, with the
 * line it's on, so every answer can cite "discounts, line 3".
 *
 * A document looks like:
 *   # Discount policy (Harbor Office Supply)      <- the title (line 1)
 *                                                   <- blank
 *   1. Sales staff may give a discount of ...      <- one passage, line 3
 *   2. Discounts above 15% ...                     <- one passage, line 4
 *
 * One rule per passage keeps each passage about ONE thing, so its embedding isn't a blur
 * of several rules, and the citation points at exactly the rule that answers.
 */

export interface Passage {
  line: number;
  content: string;
}

export const MAX_DOCUMENT_CHARS = 20_000;
export const MAX_PASSAGES = 100;
const MAX_PASSAGE_CHARS = 2_000;

export function splitDocument(text: string): { title: string | null; passages: Passage[] } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let title: string | null = null;
  const passages: Passage[] = [];
  lines.forEach((raw, i) => {
    const line = raw.trim();
    const heading = line.match(/^#\s+(.+)$/);
    if (heading && title === null) title = heading[1]!.trim();
    const rule = line.match(/^\d{1,3}[.)]\s+(.+)$/);
    if (rule) passages.push({ line: i + 1, content: rule[1]!.trim().slice(0, MAX_PASSAGE_CHARS) });
  });
  return { title, passages };
}

/**
 * What we actually embed for a passage: the document title plus the rule. The title
 * tells the model what the rule is about ("Returns policy: Opened items may be returned
 * within 14 days…"), which helps short rules match the right questions.
 */
export const passageText = (title: string, content: string) => `${title}: ${content}`;
