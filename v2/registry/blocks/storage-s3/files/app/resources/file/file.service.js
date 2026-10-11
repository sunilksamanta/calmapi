import { ResourceService } from '#calm';
import { remove } from '#app/blocks/storage-s3/s3.js';

export default class FileService extends ResourceService {
  async afterDelete(doc) {
    if (doc.key) await remove(doc.key).catch((err) => this.log.warn('Could not delete S3 object', { key: doc.key, err }));
  }
}
