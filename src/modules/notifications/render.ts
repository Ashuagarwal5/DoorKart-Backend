import type { NotificationContext } from './context.js';
import { getEvent } from './events.js';
import { cleanText, truncate } from './format.js';
import { getVariable, type StoreInfo, VARIABLES } from './variables.js';

export const TITLE_MAX = 65;
export const BODY_MAX = 240;
const VALUE_MAX = 80;

const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/g;

/** Keys of the variables an event's templates may use. */
export function variablesForEvent(eventKey: string) {
  const groups = getEvent(eventKey)?.variableGroups ?? [];
  return VARIABLES.filter((variable) => groups.includes(variable.group));
}

/**
 * Checks template text for an event. Only `{known_variable}` placeholders are allowed; any
 * other brace is rejected, which also keeps expression-like input such as `{{1+1}}` out.
 * Returns human-readable problems, empty when the text is valid.
 */
export function validateTemplateText(text: string, eventKey: string): string[] {
  const allowed = new Set(variablesForEvent(eventKey).map((variable) => variable.key));
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) {
    const key = match[1]!;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!getVariable(key)) problems.push(`Unknown variable {${key}}.`);
    else if (!allowed.has(key)) problems.push(`{${key}} is not available for this event.`);
  }
  if (/[{}]/.test(text.replace(PLACEHOLDER, ''))) {
    problems.push('Use {variable_name} placeholders only; other braces are not allowed.');
  }
  return problems;
}

export type RenderMode = 'inbox' | 'push';

/** Substitutes variables with safe, formatted values. Never throws and never leaves a raw placeholder. */
export function renderText(
  text: string,
  context: NotificationContext,
  store: StoreInfo,
  mode: RenderMode,
  max: number
): string {
  const rendered = text.replace(PLACEHOLDER, (_whole, key: string) => {
    const variable = getVariable(key);
    if (!variable) return '';
    if (mode === 'push' && variable.sensitive) return variable.fallback;
    const value = variable.resolve(context, store);
    const clean = value === null ? '' : cleanText(value).replace(/[{}]/g, '');
    return truncate(clean === '' ? variable.fallback : clean, VALUE_MAX);
  });
  return truncate(cleanText(rendered).replace(/\s+([,.!?])/g, '$1'), max);
}

export function renderNotification(
  template: { title: string; body: string },
  context: NotificationContext,
  store: StoreInfo
) {
  return {
    title: renderText(template.title, context, store, 'inbox', TITLE_MAX),
    body: renderText(template.body, context, store, 'inbox', BODY_MAX),
    pushTitle: renderText(template.title, context, store, 'push', TITLE_MAX),
    pushBody: renderText(template.body, context, store, 'push', BODY_MAX),
  };
}
