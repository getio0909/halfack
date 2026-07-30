const MAX_DIAGNOSTIC_SEGMENT_LENGTH = 128;
const UNSAFE_DIAGNOSTIC_CHARACTER =
  /[\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu;

export function escapeDiagnosticText(value: string): string {
  const bounded =
    value.length <= MAX_DIAGNOSTIC_SEGMENT_LENGTH
      ? value
      : `${value.slice(0, MAX_DIAGNOSTIC_SEGMENT_LENGTH)}…`;
  return JSON.stringify(bounded).slice(1, -1).replace(UNSAFE_DIAGNOSTIC_CHARACTER, escapeCodeUnit);
}

export function formatDiagnosticPath(segments: readonly PropertyKey[]): string {
  if (segments.length === 0) {
    return '/';
  }

  return `/${segments
    .map((segment) =>
      escapeDiagnosticText(String(segment)).replaceAll('~', '~0').replaceAll('/', '~1'),
    )
    .join('/')}`;
}

function escapeCodeUnit(value: string): string {
  return `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}`;
}
