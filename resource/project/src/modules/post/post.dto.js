'use strict';

class GetDTO {
    constructor( { ...props } ) {
        this._id = props._id;
        this.title = props.title;
        this.content = props.content;
        this.slug = props.slug;
        Object.freeze( this );
    }
}


class InsertDTO {
    constructor( { ...props } ) {
        this.title = props.title;
        this.content = props.content;
        Object.freeze( this );
    }
}

class UpdateDTO {
    constructor( { ...props } ) {
        this.title = props.title;
        this.content = props.content;

        // Delete Fields which are not present in data
        Object.keys( this ).forEach( key => {
            if ( this[ key ] === undefined ) {
                delete this[ key ];
            }
        } );
        Object.freeze( this );
    }
}

module.exports = { GetDTO, InsertDTO, UpdateDTO };
