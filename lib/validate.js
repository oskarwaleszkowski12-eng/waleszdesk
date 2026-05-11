const { z } = require('zod');

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        ok: false,
        error: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', '),
      });
    }
    req.body = result.data;
    next();
  };
}

function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return res.status(400).json({
        ok: false,
        error: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', '),
      });
    }
    req.query = result.data;
    next();
  };
}

module.exports = { validate, validateQuery, z };
