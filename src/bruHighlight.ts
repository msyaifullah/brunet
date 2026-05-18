/**
 * CodeMirror 6 syntax highlighting for Bruno (.bru) files.
 *
 * Since .bru files use a custom format (not a standard grammar), we implement
 * a StreamLanguage-based highlighter using the @codemirror/language StreamLanguage API.
 * This avoids needing to write a full Lezer grammar while still providing
 * proper token-based highlighting that Obsidian's CM6 instance can use.
 */

import { StreamLanguage, StringStream } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { LanguageSupport } from "@codemirror/language";

const HTTP_METHODS = new Set([
  "get", "post", "put", "patch", "delete", "head", "options", "connect", "trace",
]);

const SECTION_KEYWORDS = new Set([
  "meta",
  "headers",
  "query",
  "body",
  "assert",
  "docs",
  "vars",
]);


interface BruState {
  /** Current section name (lowercased) or empty string */
  section: string;
  /** Whether we are inside a block (between { and }) */
  inBlock: boolean;
  /** Brace depth for nested JSON */
  depth: number;
  /** Whether current section is a freeform/script section */
  freeform: boolean;
}

function isFreeform(section: string): boolean {
  return (
    section.startsWith("script:") ||
    section.startsWith("body:") ||
    section === "docs"
  );
}

export const bruStreamLanguage = StreamLanguage.define<BruState>({
  name: "bru",

  startState(): BruState {
    return { section: "", inBlock: false, depth: 0, freeform: false };
  },

  token(stream: StringStream, state: BruState): string | null {
    // Comments
    if (stream.match(/^\/\/.*/)) {
      return "comment";
    }

    // Opening brace at end of section header line — handled after section name
    // Closing brace (end of block)
    if (stream.match("}")) {
      if (state.depth > 1) {
        state.depth--;
        return "punctuation";
      }
      state.inBlock = false;
      state.section = "";
      state.freeform = false;
      state.depth = 0;
      return "punctuation";
    }

    // Opening brace — either part of section header or nested JSON
    if (stream.match("{")) {
      if (!state.inBlock) {
        state.inBlock = true;
        state.freeform = isFreeform(state.section);
        state.depth = 1;
      } else {
        state.depth++;
      }
      return "punctuation";
    }

    // If we're in a freeform section (scripts, body:json, docs), highlight specially
    if (state.inBlock && state.freeform) {
      return tokenFreeform(stream, state);
    }

    // If we're inside a key:value block
    if (state.inBlock) {
      return tokenKeyValue(stream, state);
    }

    // Outside a block — we are at the section header level
    return tokenSectionHeader(stream, state);
  },

  blankLine(_state: BruState): void {
    // no-op
  },

  copyState(state: BruState): BruState {
    return { ...state };
  },
});

function tokenSectionHeader(stream: StringStream, state: BruState): string | null {
  // Skip whitespace
  if (stream.eatSpace()) return null;

  // Match a word token (section name or HTTP method)
  const wordMatch = stream.match(/^[\w:~-]+/);
  if (wordMatch) {
    const word = (wordMatch as RegExpMatchArray)[0].toLowerCase();
    state.section = word;

    if (HTTP_METHODS.has(word)) {
      return "keyword"; // HTTP method — gets keyword color
    }

    const base = word.split(":")[0];
    if (SECTION_KEYWORDS.has(base) || word.startsWith("script") || word.startsWith("vars")) {
      return "typeName"; // section name — gets type color
    }

    return "variableName";
  }

  stream.next();
  return null;
}

function tokenKeyValue(stream: StringStream, state: BruState): string | null {
  // Skip leading whitespace
  if (stream.eatSpace()) return null;

  // Disabled marker
  if (stream.match("~")) {
    return "comment";
  }

  // Check for key: value pattern
  // We look ahead to see if there's a colon on this line
  const rest = stream.string.slice(stream.pos);
  const colonIdx = rest.indexOf(":");
  const newlineIdx = rest.indexOf("\n");
  const hasColon = colonIdx !== -1 && (newlineIdx === -1 || colonIdx < newlineIdx);

  if (hasColon) {
    // Read the key
    const keyEnd = stream.pos + colonIdx;
    if (stream.pos < keyEnd) {
      while (stream.pos < keyEnd) stream.next();
      return "propertyName";
    }
    // Read the colon
    if (stream.peek() === ":") {
      stream.next();
      return "operator";
    }
  }

  // Variable reference {{...}}
  if (stream.match(/^\{\{[^}]*\}\}/)) {
    return "string"; // variable refs in string color
  }

  // Quoted string
  if (stream.match(/^"(?:[^"\\]|\\.)*"/)) {
    return "string";
  }

  // Number
  if (stream.match(/^-?\d+(?:\.\d+)?/)) {
    return "number";
  }

  // Boolean / null
  if (stream.match(/^(?:true|false|null)\b/)) {
    return "keyword";
  }

  // Rest of line = value content
  if (stream.match(/^[^\n{}/]+/)) {
    return "content";
  }

  stream.next();
  return null;
}

function tokenFreeform(stream: StringStream, state: BruState): string | null {
  // Skip whitespace
  if (stream.eatSpace()) return null;

  // Variable reference {{...}}
  if (stream.match(/^\{\{[^}]*\}\}/)) {
    return "string";
  }

  // JSON string in body
  if (stream.match(/^"(?:[^"\\]|\\.)*"/)) {
    return "string";
  }

  // JS/script keywords
  if (stream.match(/^\b(?:const|let|var|function|return|if|else|for|while|bru|res|req)\b/)) {
    return "keyword";
  }

  // Number
  if (stream.match(/^-?\d+(?:\.\d+)?/)) {
    return "number";
  }

  // JS comment
  if (stream.match(/^\/\/.*/)) {
    return "comment";
  }

  if (stream.match(/^\/\*[\s\S]*?\*\//)) {
    return "comment";
  }

  // Property accessor: word.word or word(
  if (stream.match(/^\w+(?=\s*[.(])/)) {
    return "variableName";
  }

  // Generic identifier
  if (stream.match(/^\w+/)) {
    return "content";
  }

  // Brace / bracket — depth tracking handled at outer level but also emit punctuation
  if (stream.match(/^[{}[\](),;]/)) {
    return "punctuation";
  }

  stream.next();
  return null;
}

// Keep state reference for depth tracking from outer token fn
void tokenFreeform;

/**
 * Returns a LanguageSupport object that can be added to a CodeMirror EditorState.
 */
export function bruLanguage(): LanguageSupport {
  return new LanguageSupport(bruStreamLanguage);
}
