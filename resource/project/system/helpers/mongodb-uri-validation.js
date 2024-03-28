'use strict';
const validateMongoDBUri = (uri) => {
    const uriRegex = /^mongodb(?:\+srv)?:\/\/(?:[^:@/]+:[^:@/]+@)?(?:[^:@/]+\.)+[^:@/]+(?:\:\d+)?\/(?:[^?]+)(?:\?[^?]+)?$/;
    return uriRegex.test(uri);
};

module.exports = { validateMongoDBUri };
