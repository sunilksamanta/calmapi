'use strict';
const fs = require('fs');
const path = require('path');
const { config } = require('../configs/config');
const packageJson = JSON.parse(fs.readFileSync(path.resolve(`${__dirname}/../../package.json`)));

module.exports = class Swagger {
    getTemplate() {
        return {
            'openapi': '3.0.1',
            'info': {
                'title': packageJson.name,
                'description': packageJson.description,
                'version': packageJson.version,
                'termsOfService': 'http://swagger.io/terms/',
                'contact': {
                    'email': 'apiteam@swagger.io',
                },
                'license': {
                    'name': packageJson.license,
                    'url': packageJson.homepage
                },
            },
            'externalDocs': {
                'description': packageJson.author,
                'url': packageJson.homepage
            },
            'servers': [
                {
                    'url': `http://localhost:${process.env.PORT || config.PORT}/api`
                }
            ],
            'security': [
                {
                    'bearerAuth': []
                }
            ],
            'tags': [],
            'paths': {},
            'components': {
                'securitySchemes': {
                    'bearerAuth': {
                        'type': 'http',
                        'scheme': 'bearer',
                        'bearerFormat': 'JWT'
                    }
                }
            }
        };
    }
    create(param, method, moduleName) {
        const temp = {
            [ method ]: {
                'tags': [
                    moduleName
                ],
                'summary': 'sample route summary',
                'description': 'sample route description',
            }
        };
        if(method === 'get') {
            temp[ method ].parameters = [
                {
                    'in': 'query',
                    'name': 'skip',
                    'schema': {
                        'type': 'integer'
                    },
                    'description': 'The number of items to skip'
                },
                {
                    'in': 'query',
                    'name': 'limit',
                    'schema': {
                        'type': 'integer'
                    },
                    'description': 'The numbers of items to return'
                }
            ];
        };
        if(param) {
            if(!temp[ method ].parameters) {
                temp[ method ].parameters = [];
            };
            temp[ method ].parameters.push(
                {
                    'name': param,
                    'in': 'path',
                    'description': `insert ${param}`,
                    'required': true,
                }
            );
        };
        if(method === 'post') {
            temp[ method ].requestBody = {
                'description': 'sample request body description',
                'content': {
                    'application/json': {
                        'schema': {
                            'type': 'object',
                            'properties': {
                                'props1': {
                                    'type': 'string'
                                },
                                'props2': {
                                    'type': 'string'
                                }
                            }
                        }
                    }
                },
                'required': true
            };
        };
        temp[ method ].responses = {
            '200': {
                'description': 'OK',
                'content': {
                    'application/json': {
                        'schema': {
                            'type': 'object'
                        }
                    }
                }
            },
            '201': {
                'description': 'Created',
            },
            '202': {
                'description': 'Accepted',
            },
            '400': {
                'description': 'Bad Request',
            },
            '401': {
                'description': 'Unauthorized',
            },
            '404': {
                'description': 'Not Found',
            },
            '500': {
                'description': 'Internal Server Error',
            },
        };
        return temp;
    }
    createTag(module) {
        return {
            'name': module,
            'description': 'Sample module Description',
            'externalDocs': {
                'description': 'Find out more',
                'url': 'http://swagger.io'
            }
        };
    }
};
