// ---------------------------------------------------------------------------
// env-file.ts — Read/update .env without duplicate keys
// ---------------------------------------------------------------------------
import { existsSync, readFileSync, writeFileSync } from 'fs';

const ASSIGNMENT_REGEX = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

function parseValue(raw: string): string {
  const s = raw.trim();

  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\"/g, '"');
  }

  return s;
}

/**
 * Read the current value of a key from an env file. Returns null if missing.
 */
export function getEnvFromFile(filePath: string, key: string): string | null {
  try {
    const content = readFileSync(filePath, 'utf-8');

    const line = content.split('\n').find((l) => {
      const m = l.match(ASSIGNMENT_REGEX);

      return m && m[1] === key;
    });

    if (!line) {
      return null;
    }

    const m = line.match(ASSIGNMENT_REGEX);

    return m ? parseValue(m[2]) : null;
  } catch {
    return null;
  }
}

function formatValue(value: string): string {
  if (/[\s#"'\n]/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  return value;
}

/**
 * Set or update a key in an env file. Replaces existing line if key exists, otherwise appends.
 * Pass null to remove the key. Creates the file if it does not exist and value is not null.
 */
export function setEnvInFile(filePath: string, key: string, value: string | null): void {
  if (!existsSync(filePath)) {
    if (value === null) {
      return;
    }

    writeFileSync(filePath, `${key}=${formatValue(value)}\n`, 'utf-8');

    return;
  }

  const content = readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
  const lines = content.split('\n');
  let found = false;
  const newLines: string[] = [];

  for (const line of lines) {
    const m = line.match(ASSIGNMENT_REGEX);

    if (m && m[1] === key) {
      found = true;

      if (value !== null) {
        newLines.push(`${key}=${formatValue(value)}`);
      }
    } else {
      newLines.push(line);
    }
  }

  if (!found && value !== null) {
    newLines.push(`${key}=${formatValue(value)}`);
  }

  writeFileSync(filePath, newLines.join('\n') + (newLines.length > 0 ? '\n' : ''), 'utf-8');
}
