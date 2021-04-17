'use strict';
const autoBind = require( 'auto-bind' );
class CalmService {
    /**
     * Calm Service
     * @author Sunil Kumar Samanta
     * @param model
     */
    constructor( model ) {
        this.model = model;
        autoBind( this );
    }

    /**
     * Get All Items
     * @param { Object } query Query Parameters
     */
    async getAll( query ) {
        let { skip, limit, sortBy } = query;

        skip = skip ? Number( skip ) : 0;
        limit = limit ? Number( limit ) : 10;
        sortBy = sortBy ? sortBy : { 'createdAt': -1 };

        delete query.skip;
        delete query.limit;
        delete query.sortBy;

        try {
            const items = await this.model.find( query ).sort( sortBy ).skip( skip ).limit( limit );

            const total = await this.model.countDocuments( query );

            return { 'data': JSON.parse( JSON.stringify( items ) ), total };
        } catch ( errors ) {
            throw errors;
        }
    }

    /**
     * Get Single Item
     * @param { string } id Instance ID
     */
    async get( id ) {
        try {
            const item = await this.model.findById( id );

            if ( !item ) {
                const error = new Error( 'Item not found' );

                error.statusCode = 404;
                throw error;
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
            throw new Error( 'Something wrong happened' );

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
            const item = await this.model.findByIdAndUpdate( id, { ...data }, { 'new': true } );

            if ( item ) {
                return { 'data': item.toJSON() };
            }
            throw new Error( 'Something wrong happened' );
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
                const error = new Error( 'Item not found' );

                error.statusCode = 404;
                throw error;
            } else {
                return { 'data': item.toJSON(), 'deleted': true };
            }
        } catch ( errors ) {
            throw errors;
        }
    }
}

module.exports = {
    CalmService
};
