'use strict';
/**
 * Custom Error Definition
 * @author Sunil Kumar Samanta
 */
class CalmError extends Error {
    error = true;
    responseTimestamp = new Date();
    /**
     * Calm Error
     * @param {('NOT_FOUND_ERROR'|'PERMISSION_DENIED_ERROR'|'UNAUTHORIZED_ERROR'|'INTERNAL_SERVER_ERROR'|'UNKNOWN_ERROR'|'VALIDATION_ERROR') | null} type
     * @param {string | null} [message]
     * @param {number | null} [statusCode]
     * @param {Object | null} [errors]
     */
    constructor(type = null, message = null, statusCode = null, errors = null) {
        super();
        this.name = type || 'CUSTOM_ERROR';

        switch (type) {
            case 'NOT_FOUND_ERROR': {
                this.message = message || 'Resource not found';
                this.statusCode = statusCode || 404;
                break;
            }
            case 'PERMISSION_DENIED_ERROR': {
                this.message = message || 'You don\'t have permission to access this resource';
                this.statusCode = statusCode || 403;
                break;
            }
            case 'UNAUTHORIZED_ERROR': {
                this.message = message || 'You are not authorized to access this resource';
                this.statusCode = statusCode || 401;
                break;
            }
            case 'UNKNOWN_ERROR': {
                this.message = message || 'Something Wrong has happened';
                this.statusCode = statusCode || 400;
                break;
            }
            case 'VALIDATION_ERROR': {
                this.message = message || 'Something Wrong has happened';
                this.statusCode = statusCode || 422;
                if( errors) {
                    this.errors = errors;
                }
                break;
            }
            default : {
                this.message = message || 'Something Wrong has happened';
                this.statusCode = statusCode || 500;
            }
        }
    }
}

module.exports = {
    CalmError
};
