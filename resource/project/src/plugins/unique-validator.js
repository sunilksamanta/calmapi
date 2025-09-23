class UniqueValidator {
    constructor(options = {}) {
        this.options = options;
    }

    apply(schema) {
        schema.eachPath((path, schemaType) => {
            if (schemaType.options.unique) {
                schema.path(path).validate({
                    validator: async function(value) {
                        if (!value) {
                            return true;
                        }

                        const query = { [ path ]: value };
                        if (this._id) {
                            query._id = { $ne: this._id };
                        }

                        const existing = await this.constructor.findOne(query).lean();
                        return !existing;
                    },
                    // Custom error message
                    // eslint-disable-next-line
                    message: props => {
                        const field = path.charAt(0).toUpperCase() + path.slice(1); // Capitalize first letter
                        return `${field} already exists.`;
                    }
                });
            }
        });
    }
}
// Plugin wrapper (this is what Mongoose expects)
const uniqueValidatorPlugin = function(schema, options) {
    const validator = new UniqueValidator(options);
    validator.apply(schema);
};

module.exports = uniqueValidatorPlugin ;
