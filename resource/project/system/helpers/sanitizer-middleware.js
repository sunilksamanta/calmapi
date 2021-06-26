'use strict';
/**
 * Sanitize Request Body, Query & Params to prevent MongoDB Injections
 * @author Sunil K Samanta
 * Usage: Use exported method as middleware before you pass the request to your methods
 * You can use this globally like app.use(sanitizerMiddleware);
 * @param dangerousObject
 * @returns {*}
 */
// eslint-disable-next-line func-style
function sanitizeData(dangerousObject) {
    if (dangerousObject instanceof Object) {
        for (const key in dangerousObject) {
            if (dangerousObject.hasOwnProperty(key) && /^\$/.test(key)) {
                delete dangerousObject[ key ];
            } else {
                // Check recursively if child Object has any illegal keys
                sanitizeData(dangerousObject[ key ]);
            }
        }
    }
    return dangerousObject;
}
const sanitizerMiddleware = (req, res, next) => {
    sanitizeData(req.params); // Sanitizing Params
    sanitizeData(req.query); // Sanitizing Query
    sanitizeData(req.body); // Sanitizing Body
    next();
};

module.exports = { sanitizerMiddleware };
