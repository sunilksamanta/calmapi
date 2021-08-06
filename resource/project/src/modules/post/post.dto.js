'use strict';

class GetDTO {
    constructor( { ...props } ) {
        this._id = props._id;
        this.title = props.title;
        this.content = props.content;
        this.slug = props.slug;
        // Auto Generated Fields
        this.createdBy = props.createdBy;
        this.updatedBy = props.updatedBy;
        this.createdAt = props.createdAt;
        this.updatedAt = props.updatedAt;
        Object.freeze( this );
    }
}


class InsertDTO {
    constructor( { ...props } ) {
        this.title = props.title;
        this.content = props.content;
        this.createdBy = props.createdBy;

        Object.freeze( this );
    }
}

class UpdateDTO {
    constructor( { ...props } ) {
        this.title = props.title;
        this.content = props.content;
        this.updatedBy = props.updatedBy;
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
