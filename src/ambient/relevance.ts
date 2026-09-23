/**
 * Rule-based check of whether a prompt is about code, so the ambient hook can
 * skip chat ("thanks", "sounds good") without touching the graph. No model
 * call: it only looks for code-shaped text and coding words.
 */

export interface Relevance {
  code: boolean;
  /** Which rules fired, for tests and `glassbox context --json`. */
  signals: string[];
}

const CHAT_ONLY =
  /^(hi|hello|hey|thanks|thank you|thx|ok|okay|k|yes|yep|no|nope|y|n|sure|cool|great|nice|continue|go on|go ahead|proceed|sounds good|lgtm|done|stop)\b[\s.!?]*$/i;

const FILE_PATH = /\b[\w@.-]+\/[\w@.-]+\/|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|cs|c|cc|cpp|h|hpp|kt|swift|scala|sh|sql|vue|svelte)\b/;
const CAMEL = /\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/;
const PASCAL = /\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/;
const SNAKE = /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/;
const CALL = /\b[A-Za-z_$][\w$]*\(\)/;
const BACKTICK = /`[^`\n]+`|```/;
const STACK = /\bat [\w$.<>]+ \(|Traceback \(most recent call last\)|\b(?:TypeError|ReferenceError|SyntaxError|ValueError|KeyError|NullPointerException)\b/;

const CODE_WORDS = new Set(
  (
    'bug bugs fix fixes fixing refactor refactoring implement implementation function functions method methods class classes ' +
    'module modules test tests testing spec endpoint endpoints api handler handlers middleware route routes router ' +
    'error errors exception exceptions crash crashes regression compile compiler build lint typecheck type types schema ' +
    'migration query queries database db sql auth authentication login session sessions token tokens password ' +
    'config configuration dependency dependencies import imports export exports repo codebase code variable variables ' +
    'rename callers caller call calls return returns interface component components hook hooks deploy script scripts ' +
    'retry retries billing invoice payment parser parse cache logging logger performance leak async await promise'
  ).split(' '),
);

const ASKS_ABOUT_CODE = /\b(?:where (?:is|are|does|do)|how does|what calls|who calls|which file|which function)\b/i;

/** Decides whether the prompt is about code. Slash commands and short chat are not. */
export function codeRelevance(prompt: string): Relevance {
  const text = prompt.trim();
  if (text.length < 4 || CHAT_ONLY.test(text) || /^\/[\w:-]+(?:\s|$)/.test(text)) return { code: false, signals: [] };
  const signals: string[] = [];
  if (FILE_PATH.test(text)) signals.push('path');
  if (CAMEL.test(text) || PASCAL.test(text)) signals.push('identifier');
  if (SNAKE.test(text)) signals.push('snake_case');
  if (CALL.test(text)) signals.push('call');
  if (BACKTICK.test(text)) signals.push('backticks');
  if (STACK.test(text)) signals.push('stack');
  if (ASKS_ABOUT_CODE.test(text)) signals.push('question');
  const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (words.some((w) => CODE_WORDS.has(w))) signals.push('words');
  return { code: signals.length > 0, signals };
}
