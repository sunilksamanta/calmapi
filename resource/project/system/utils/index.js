'use strict';
const excludeKeysFromData = (data, excludedKeys = []) => {
    if(data === null) {
        return data;
    }
    if (Array.isArray(data)) {
        data.forEach((item, index) => {
            data[ index ] = excludeKeysFromData(item, excludedKeys);
        });
    } else if (typeof (data) === 'object' && Object.keys(data).length) {
        Object.keys(data).forEach(key => {
            if (excludedKeys.includes(key)) {
                delete data[ key ];
            } else if (data[ key ] && typeof (data[ key ]) === 'object' && Object.keys(data[ key ]).length) {
                // eslint-disable-next-line no-unused-vars
                data[ key ] = excludeKeysFromData(data[ key ], excludedKeys);
            }
        });
    }
    return data;
};

module.exports = {
    excludeKeysFromData
};
