'use strict';
const { config } = require('../configs/config');
const { excludeKeysFromData } = require('../utils');

/**
 * Calm Response Class
 * @author Sunil Kumar Samanta
 */
class CalmResponse {
    success = true;
    responseTimestamp = new Date();

    /**
     *
     * @param data
     * @param {{[totalCount]: number|null, [statusCode]: number, [deleted]: boolean | null, [updated]: boolean | null}} options
     */
    constructor(data, options = {
        totalCount: null,
        statusCode: 200,
        deleted: null,
        updated: null
    }) {
        const deepCopyData = JSON.parse(JSON.stringify(data));
        const filteredData = excludeKeysFromData(deepCopyData, config.EXCLUDED_ITEMS_FROM_RESPONSE);
        if(options.deleted !== null) {
            this.deleted = options.deleted;
        }
        if(options.updated !== null) {
            this.updated = options.updated;
        }
        if(options.totalCount !== null) {
            this.totalCount = options.totalCount;
        }
        if ( Array.isArray( filteredData ) ) {
            this.data = [ ...filteredData ];
        } else if ( typeof ( filteredData ) === 'object' ) {
            this.data = { ...filteredData };
        } else {
            this.data = data;
        }
    }
}


module.exports = {
    CalmResponse
};
