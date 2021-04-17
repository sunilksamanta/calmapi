'use strict';
const mongoose = require( 'mongoose' );
const { Schema } = require( 'mongoose' );
const uniqueValidator = require( 'mongoose-unique-validator' );
const { slugify } = require( '../../utils' );

class Sample {

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
            mongoose.model( 'sample', schema );
        } catch ( e ) {

        }

    }

    getInstance() {
        this.initSchema();
        return mongoose.model( 'sample' );
    }
}

module.exports = { Sample };
