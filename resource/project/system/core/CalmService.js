'use strict';
const autoBind = require( 'auto-bind' );
class CalmService {
    populateFields = [];
    /**
     * Calm Service
     * @author Sunil Kumar Samanta
     * @param model Current Model Instance
     */
    constructor( model ) {
        this.model = model;
        this.parseObj = data => JSON.parse(JSON.stringify(data));
        autoBind( this );
    }

    /**
     * Get All Items
     * @param { Object } query Query Parameters
     * @param {Object} [ops] Options
     * @param {Array} [ops.populateFields] Populate Fields
     */
    async getAll( query, ops = {} ) {
        let populateFields = this.populateFields;
        if(Array.isArray(ops.populateFields)) {
            populateFields = ops.populateFields;
        }
        // eslint-disable-next-line prefer-const
        let { skip, limit, sortBy, ...restQuery } = query;

        skip = skip ? Number( skip ) : 0;
        limit = limit ? Number( limit ) : 10;
        sortBy = sortBy ? sortBy : { 'createdAt': -1 };

        try {
            const items = await this.model.find( restQuery ).sort( sortBy ).skip( skip ).limit( limit ).populate(populateFields);

            const total = await this.model.countDocuments( restQuery );

            return { 'data': this.parseObj( items ), total };
        } catch ( errors ) {
            throw errors;
        }
    }

    /**
     * Get Single Item
     * @param { string } id Instance ID
     * @param {Object} [ops] Options
     * @param {Array} [ops.populateFields] Populate Fields [{path: 'fieldName', select: 'prop1 prop2 ...', populate: 'childFieldName'}]
     */
    async get( id, ops = {} ) {
        let populateFields = this.populateFields;
        if(Array.isArray(ops.populateFields)) {
            populateFields = ops.populateFields;
        }
        try {
            const item = await this.model.findById( id ).populate(populateFields);

            if ( !item ) {
                throw new Error('NOT_FOUND_ERROR');
            }

            return { 'data': item.toJSON() };
        } catch ( errors ) {
            throw errors;
        }
    }

    /**
     * Create Item
     * @param { Object } data Instance Object
     */
    async insert( data ) {
        try {
            const item = await this.model.create( data );
            if ( item ) {
                return { 'data': item.toJSON() };
            }
            throw new Error( 'UNKNOWN_ERROR' );

        } catch ( error ) {
            throw error;
        }
    }

    /**
     * Update Item
     * @param { string } id Instance ID
     * @param { Object } data Updated Object
     */
    async update( id, data ) {
        try {
            const item = await this.model.findByIdAndUpdate( id, { ...data }, { 'new': true, runValidators: true, context: 'query' } );

            if ( item ) {
                return { 'data': this.parseObj( item ) };
            }
            throw new Error( 'NOT_FOUND_ERROR' );
        } catch ( errors ) {
            throw errors;
        }
    }

    /**
     * Delete Item
     * @param { string } id Item ID
     */
    async delete( id ) {
        try {
            const item = await this.model.findByIdAndDelete( id );

            if ( !item ) {
                throw new Error('NOT_FOUND_ERROR');
            } else {
                return { 'data': this.parseObj( item ), 'deleted': true };
            }
        } catch ( errors ) {
            throw errors;
        }
    }
}

module.exports = {
    CalmService
};
