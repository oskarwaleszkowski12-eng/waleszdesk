const { z } = require('zod');

const isProd = process.env.NODE_ENV === 'production';

function formatErrors(issues) {
  if (isProd) return 'Nieprawidłowe dane wejściowe.';
  return issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
}

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ ok: false, error: formatErrors(result.error.issues) });
    }
    req.body = result.data;
    next();
  };
}

function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return res.status(400).json({ ok: false, error: formatErrors(result.error.issues) });
    }
    req.query = result.data;
    next();
  };
}

module.exports = { validate, validateQuery, z };
