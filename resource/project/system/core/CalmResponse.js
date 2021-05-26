'use strict';
const { config } = require('../configs/config');
const { excludeKeysFromData } = require('../utils');

module.exports = {
    /**
     *
     * @param {[] | {}} data
     * @param {{[totalCount]: number|null, [statusCode]: number, [deleted]: boolean | null, [updated]: boolean | null}} options
     */
    CalmResponse: function(data, options = {
        totalCount: null,
        statusCode: 200,
        deleted: null,
        updated: null
    }) {
        const deepCopyData = JSON.parse(JSON.stringify(data));
        const filteredData = excludeKeysFromData(deepCopyData, config.EXCLUDED_ITEMS_FROM_RESPONSE);
        const responseObj = {
            error: false,
            status: true,
            statusCode: 200,
            responseTimestamp: new Date()
        };
        if(options.deleted !== null) {
            responseObj.deleted = options.deleted;
        }
        if(options.updated !== null) {
            responseObj.updated = options.updated;
        }
        if(options.totalCount !== null) {
            responseObj.totalCount = options.totalCount;
        }
        if ( Array.isArray( filteredData ) ) {
            responseObj.data = [ ...filteredData ];
        } else if ( typeof ( filteredData ) === 'object' ) {
            responseObj.data = { ...filteredData };
        } else {
            responseObj.data = data;
        }
        this.status(200).json(responseObj);

    }
};
