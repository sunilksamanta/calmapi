'use strict';
const autoBind = require('auto-bind');
const defaultDTO = require('./CalmDTO');
class CalmController {
    /**
     * Calm Controller
     * @author Sunil Kumar Samanta
     * @param { any } service
     */
    constructor( service ) {
        this.service = service;
        this.dto = defaultDTO;
        autoBind( this );
    }

    async getAll( req, res, next ) {
        try {
            const response = await this.service.getAll( req.query );
            res.sendCalmResponse( response.data.map( x => new this.dto.GetDTO( x ) ), { 'totalCount': response.total } );
        } catch ( e ) {
            next( e );
        }
    }

    async get( req, res, next ) {
        const { id } = req.params;

        try {
            const response = await this.service.get( id );

            res.sendCalmResponse( new this.dto.GetDTO( response.data ) );
        } catch ( e ) {
            next( e );
        }
    }

    async insert( req, res, next ) {
        try {
            // if Authorized, Set Created By
            if(req.user) {
                req.body.createdBy = req.user._id;
            }
            const response = await this.service.insert( new this.dto.InsertDTO( req.body ) );

            res.sendCalmResponse( new this.dto.GetDTO( response.data ) );
        } catch ( e ) {
            next( e );
        }
    }

    async update( req, res, next ) {
        const { id } = req.params;

        try {
            // if Authorized, Set Created By
            if(req.user) {
                req.body.updatedBy = req.user._id;
            }
            const response = await this.service.update( id, new this.dto.UpdateDTO( req.body ) );

            res.sendCalmResponse( new this.dto.GetDTO( response.data ) );
        } catch ( e ) {
            next( e );
        }
    }

    async delete( req, res, next ) {
        const { id } = req.params;

        try {
            const response = await this.service.delete( id );

            res.sendCalmResponse( new this.dto.GetDTO( response.data ), { 'deleted': response.deleted } );
        } catch ( e ) {
            next( e );
        }
    }
}

module.exports = {
    CalmController
};
