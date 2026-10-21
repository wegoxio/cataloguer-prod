import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';
import { StorageUrlPolicyService } from './policy/storage-url-policy.service';

@Module({
  providers: [StorageService, StorageUrlPolicyService],
  exports: [StorageService, StorageUrlPolicyService],
})
export class StorageModule {}
