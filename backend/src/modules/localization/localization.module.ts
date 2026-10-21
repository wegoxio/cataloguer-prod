import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { ProductTranslation } from './entities/product-translation.entity';
import { CategoryTranslation } from './entities/category-translation.entity';
import { TranslationsService } from './translations.service';
import { CategoryTranslationsController, ProductTranslationsController } from './translations.controller';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';

/**
 * The localization contract (P5-W2): canonical copy stays on the item, other
 * languages live beside it, and resolution is deterministic and Spanish-first.
 */
@Module({
  imports: [MikroOrmModule.forFeature([ProductTranslation, CategoryTranslation]), AuthModule, UsersModule],
  controllers: [ProductTranslationsController, CategoryTranslationsController],
  providers: [TranslationsService],
  exports: [TranslationsService],
})
export class LocalizationModule {}
