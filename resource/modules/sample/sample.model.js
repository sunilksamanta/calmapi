'use strict';
const mongoose = require( 'mongoose' );
const { Schema } = require( 'mongoose' );
const uniqueValidator = require( 'mongoose-unique-validator' );
const { slugify } = require( '../../utils' );

class MODULE_SINGULAR_PASCAL {

    initSchema() {
        const schema = new Schema( {
            'title': {
                'type': String,
                'required': true,
            },
            'slug': String,
            'content': {
                'type': String,
                'required': true,
            }
        }, { 'timestamps': true } );

        schema.pre( 'save', function( next ) {
            const sample = this;

            if ( !sample.isModified( 'title' ) ) {
                return next();
            }
            sample.slug = slugify( sample.title );
            return next();
        } );

        schema.plugin( uniqueValidator );
        try {
            mongoose.model( 'MODULE_SINGULAR_CAMEL', schema );
        } catch ( e ) {

        }

    }

    getInstance() {
        this.initSchema();
        return mongoose.model( 'MODULE_SINGULAR_CAMEL' );
    }
}

module.exports = { MODULE_SINGULAR_PASCAL };
