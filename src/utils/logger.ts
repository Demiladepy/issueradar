/** ANSI-colored terminal logger. No external deps — raw escape codes only. */

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[37m';

const BG_RED = '\x1b[41m';
const BG_YELLOW = '\x1b[43m';

/** Severity score → colored label. */
const SEVERITY_COLOR: Record<number, string> = {
  5: `${BG_RED}${WHITE}${BOLD} CRITICAL `,
  4: `${RED}${BOLD}HIGH     `,
  3: `${YELLOW}${BOLD}MEDIUM   `,
  2: `${BLUE}${BOLD}LOW      `,
  1: `${DIM}TRIVIAL  `,
};

/** Issue type → colored label. */
const TYPE_COLOR: Record<string, string> = {
  bug: `${RED}bug${RESET}`,
  feature: `${MAGENTA}feature${RESET}`,
  question: `${CYAN}question${RESET}`,
  noise: `${DIM}noise${RESET}`,
};

/** Logger namespace for module-tagged output. */
export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  success(msg: string): void;
  dim(msg: string): void;
  step(callNum: number, name: string, ms?: number): void;
}

/**
 * Creates a tagged logger instance.
 *
 * @param tag - Module name shown in brackets, e.g. 'pipeline'
 * @returns Logger bound to that tag
 */
export function createLogger(tag: string): Logger {
  const prefix = `${DIM}[${tag}]${RESET}`;
  return {
    info: (msg) => console.info(`${prefix} ${msg}`),
    warn: (msg) => console.warn(`${prefix} ${YELLOW}⚠ ${msg}${RESET}`),
    error: (msg) => console.error(`${prefix} ${RED}✖ ${msg}${RESET}`),
    success: (msg) => console.info(`${prefix} ${GREEN}✔ ${msg}${RESET}`),
    dim: (msg) => console.info(`${DIM}${msg}${RESET}`),
    step: (callNum, name, ms) => {
      const timing = ms !== undefined ? `${DIM} (${ms}ms)${RESET}` : '';
      console.info(`${prefix} ${CYAN}Call ${callNum}${RESET} ${BOLD}${name}${RESET}${timing}`);
    },
  };
}

/**
 * Formats and prints a full analysis result to stdout.
 * Used by the CLI `analyze` command.
 */
export function printAnalysisResult(result: {
  classification: { type: string; confidence: number };
  extracted: {
    title: string;
    description: string;
    stepsToReproduce: string[];
    expectedBehavior: string;
    actualBehavior: string;
    affectedModule: string;
    affectedVersion: string | null;
  };
  severity: { score: number; reason: string; label: string };
  deduplication: { duplicateIds: string[] };
  trace?: { classifyMs: number; extractMs: number; scoreMs: number; deduplicateMs: number; totalMs: number };
}): void {
  const { classification, extracted, severity, deduplication, trace } = result;
  const sevColor = SEVERITY_COLOR[severity.score] ?? SEVERITY_COLOR[1]!;
  const typeTag = TYPE_COLOR[classification.type] ?? classification.type;

  console.info('');
  console.info(`${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.info(`${BOLD}  ${extracted.title}${RESET}`);
  console.info(`${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.info('');
  console.info(`  ${sevColor}${severity.score}/5${RESET}  ${severity.reason}`);
  console.info(`  Type    ${typeTag}  ${DIM}(${Math.round(classification.confidence * 100)}% confidence)${RESET}`);
  console.info(`  Module  ${CYAN}${extracted.affectedModule || '—'}${RESET}`);
  if (extracted.affectedVersion) {
    console.info(`  Version ${extracted.affectedVersion}`);
  }
  console.info('');

  if (extracted.description) {
    console.info(`  ${BOLD}Description${RESET}`);
    console.info(`  ${DIM}${wordWrap(extracted.description, 60)}${RESET}`);
    console.info('');
  }

  if (extracted.expectedBehavior) {
    console.info(`  ${GREEN}Expected${RESET}  ${extracted.expectedBehavior}`);
  }
  if (extracted.actualBehavior) {
    console.info(`  ${RED}Actual${RESET}    ${extracted.actualBehavior}`);
  }

  if (extracted.stepsToReproduce.length > 0) {
    console.info('');
    console.info(`  ${BOLD}Steps to reproduce${RESET}`);
    extracted.stepsToReproduce.forEach((step, i) => {
      console.info(`  ${DIM}${i + 1}.${RESET} ${step}`);
    });
  }

  if (deduplication.duplicateIds.length > 0) {
    console.info('');
    console.info(
      `  ${BG_YELLOW}${BOLD} POSSIBLE DUPLICATE ${RESET} ${deduplication.duplicateIds.join(', ')}`
    );
  }

  if (trace) {
    console.info('');
    console.info(
      `  ${DIM}Timing: classify=${trace.classifyMs}ms  extract=${trace.extractMs}ms  ` +
        `score+dedup=${trace.scoreMs}ms  total=${trace.totalMs}ms${RESET}`
    );
  }

  console.info('');
}

/**
 * Prints a compact one-line summary row — used in batch scan output.
 */
export function printIssueSummaryRow(
  index: number,
  issueNum: number | string,
  title: string,
  score: number,
  type: string,
  module: string,
  isDupe: boolean
): void {
  const pad = (s: string, n: number): string => s.slice(0, n).padEnd(n);
  const sevColor = SEVERITY_COLOR[score] ?? SEVERITY_COLOR[1]!;
  const scoreTag = `${sevColor}${score}${RESET}`;
  const dupeTag = isDupe ? ` ${YELLOW}[dupe?]${RESET}` : '';

  console.info(
    `  ${DIM}${String(index + 1).padStart(3)}.${RESET} ` +
      `#${String(issueNum).padEnd(5)} ` +
      `${scoreTag} ` +
      `${DIM}${pad(type, 8)}${RESET} ` +
      `${pad(module, 20)} ` +
      `${pad(title, 50)}${dupeTag}`
  );
}

function wordWrap(text: string, width: number): string {
  return text
    .split('\n')
    .map((line) => {
      if (line.length <= width) return line;
      const words = line.split(' ');
      const lines: string[] = [];
      let current = '';
      for (const word of words) {
        if (current.length + word.length + 1 > width) {
          if (current) lines.push(current);
          current = word;
        } else {
          current = current ? `${current} ${word}` : word;
        }
      }
      if (current) lines.push(current);
      return lines.join('\n  ');
    })
    .join('\n  ');
}
