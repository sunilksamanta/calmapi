/* eslint-disable camelcase */
'use strict';
const MODULE_SINGULAR_PASCALController = require( './MODULE_SINGULAR_KEBAB.controller' );

// 1. Definition of parameters expected by the AI agent
const aiSchema = {
    insert: {
        type: 'object',
        properties: {
            title: { type: 'string', description: 'The title data field' },
            content: { type: 'string', description: 'The body content data field' }
        },
        required: [ 'title', 'content' ]
    },
    update: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'The target document hex string ID' },
            title: { type: 'string', description: 'The updated title text string' },
            content: { type: 'string', description: 'The updated body content text string' }
        },
        required: [ 'id' ]
    },
    idOnly: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'The unique reference document database string ID' }
        },
        required: [ 'id' ]
    },
    pagination: {
        type: 'object',
        properties: {
            page: { type: 'number', description: 'The query index collection page number' },
            limit: { type: 'number', description: 'The maximum results count per single page view' }
        }
    }
};


const makeBridge = ( handler, crudType ) => {
    return async( agentArgs, activeSessionUser = null ) => {
        return new Promise( async( resolve, reject ) => {
            const req = { body: {}, params: {}, query: {}, user: activeSessionUser };

            if ( crudType === 'read' || crudType === 'update' || crudType === 'delete' ) {
                if ( agentArgs.id ) {
                    req.params.id = agentArgs.id;
                } else {
                    req.query = agentArgs;
                }
            }
            if ( crudType === 'create' || crudType === 'update' ) {
                req.body = agentArgs;
            }

            const res = {
                status: function( code ) {
                    this.statusCode = code; return this;
                },
                json: function( data ) {
                    resolve( { status: this.statusCode || 200, success: true, data } );
                    return this;
                }
            };

            try {
                await handler( req, res, ( err ) => {
                    if ( err ) {
                        reject( err );
                    }
                } );
            } catch ( err ) {
                reject( { status: 500, success: false, error: err.message } );
            }
        } );
    };
};


const tools = [
    {
        name: 'get_all_MODULE_SINGULAR_CAMEL_records',
        description: 'Operation: Queries and fetches live collection data from the system.\nWhen to use: Use this when listing, viewing, or searching MODULE_SINGULAR_CAMEL records.\nAccess Rule: ⚠️ SECURE ACTION: Requires active authenticated user session context.',
        schema: aiSchema.pagination,
        execute: makeBridge( MODULE_SINGULAR_PASCALController.getAll, 'read' )
    },
    {
        name: 'get_single_MODULE_SINGULAR_CAMEL_by_id',
        description: 'Operation: Queries and fetches information safely.\nWhen to use: Use this to load full profile parameters for one singular MODULE_SINGULAR_CAMEL item by providing its specific database ID.\nAccess Rule: ⚠️ SECURE ACTION: Requires active authenticated user session context.',
        schema: aiSchema.idOnly,
        execute: makeBridge( MODULE_SINGULAR_PASCALController.get, 'read' )
    },
    {
        name: 'create_new_MODULE_SINGULAR_CAMEL_entry',
        description: 'Operation: Permanently writes a completely brand new record into the database.\nWhen to use: Use this to insert, save, register, or publish a new MODULE_SINGULAR_CAMEL item.\nAccess Rule: ⚠️ SECURE ACTION: Requires active authenticated user session context.',
        schema: aiSchema.insert,
        execute: makeBridge( MODULE_SINGULAR_PASCALController.insert, 'create' )
    },
    {
        name: 'update_existing_MODULE_SINGULAR_CAMEL_by_id',
        description: 'Operation: Edits and modifies an existing entry metadata dataset index.\nWhen to use: Use this to patch, alter, or rewrite attribute values inside an existing MODULE_SINGULAR_CAMEL document using its ID.\nAccess Rule: ⚠️ SECURE ACTION: Requires active authenticated user session context.',
        schema: aiSchema.update,
        execute: makeBridge( MODULE_SINGULAR_PASCALController.update, 'update' )
    },
    {
        name: 'delete_MODULE_SINGULAR_CAMEL_by_id',
        description: 'Operation: Wipes out and completely deletes a record structure directly from the database.\nWhen to use: Use this to clear out, drop, remove, or permanently destroy a persistent MODULE_SINGULAR_CAMEL record by its ID.\nAccess Rule: ⚠️ SECURE ACTION: Requires active authenticated user session context.',
        schema: aiSchema.idOnly,
        execute: makeBridge( MODULE_SINGULAR_PASCALController.delete, 'delete' )
    }
];

module.exports = tools;
