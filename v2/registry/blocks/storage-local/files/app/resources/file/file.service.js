import { ResourceService } from '#calm';
import { remove } from '#app/blocks/storage-local/storage.js';

export default class FileService extends ResourceService {
  async afterDelete(doc) {
    remove(doc.key);
  }
}
