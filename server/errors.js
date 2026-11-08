'use strict';
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
module.exports = { fail, wrap };
