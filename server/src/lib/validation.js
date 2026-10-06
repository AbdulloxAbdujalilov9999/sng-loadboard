// Turns Zod issues (and route-level rule violations) into { path, code, params, message }.
// `code` is a stable key the web client translates (i18n "v_<code>"); `message` is the English fallback
// for API consumers that do not translate.

const TEMPLATES = {
  required: 'Required',
  invalid: 'Invalid value',
  number: 'Enter a number',
  integer: 'Enter a whole number',
  choice: 'Pick one of the available options',
  email: 'Enter a valid email address',
  phone: 'Enter a valid phone number',
  telegram: 'Telegram handle: 4-32 letters, digits or _',
  date_format: 'Use YYYY-MM-DD',
  date_real: 'Not a real calendar date',
  text_max: 'Too long (max {max} characters)',
  text_min: 'Too short (min {min} characters)',
  num_positive: 'Must be greater than 0',
  num_min: 'Must be at least {min}',
  num_max: 'Must be at most {max}',
  unknown_field: 'Unknown field',
  pick_city: 'Pick a city from the list',
  dest_same_as_origin: 'Must differ from origin',
  pickup_past: 'Pickup date is in the past',
  pickup_far: 'Must be within a year',
  delivery_before_pickup: 'Must not be before pickup',
  available_past: 'Is in the past',
  end_before_start: 'Must not be before start',
};

export function detail(path, code, params) {
  const message = (TEMPLATES[code] ?? TEMPLATES.invalid).replace(/\{(\w+)\}/g, (_, k) => params?.[k] ?? '');
  return params ? { path, code, params, message } : { path, code, message };
}

export function describeIssue(issue) {
  const path = issue.path.join('.');
  switch (issue.code) {
    case 'invalid_type': {
      // Zod 4 only exposes what was received inside the message text (and `received` for NaN).
      if (/received (undefined|null)\b/.test(issue.message)) return detail(path, 'required');
      return detail(path, issue.expected === 'number' ? 'number' : 'invalid'); // incl. coerce.number() of "abc" -> NaN
    }
    case 'too_small':
      if (issue.origin === 'string') return issue.minimum <= 1 ? detail(path, 'required') : detail(path, 'text_min', { min: issue.minimum });
      if (!issue.inclusive && Number(issue.minimum) === 0) return detail(path, 'num_positive');
      return detail(path, 'num_min', { min: issue.minimum });
    case 'too_big':
      if (issue.origin === 'string') return detail(path, 'text_max', { max: issue.maximum });
      return detail(path, 'num_max', { max: issue.maximum });
    case 'invalid_format':
      if (issue.message in TEMPLATES) return detail(path, issue.message); // our regex rules use the code as their message
      return detail(path, issue.format === 'email' ? 'email' : 'invalid');
    case 'invalid_value':
      return detail(path, 'choice');
    case 'unrecognized_keys':
      return detail(path, 'unknown_field');
    case 'custom':
      return detail(path, issue.message in TEMPLATES ? issue.message : 'invalid');
    default:
      return detail(path, TEMPLATES[issue.message] ? issue.message : 'invalid');
  }
}
