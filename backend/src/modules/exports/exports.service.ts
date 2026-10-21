import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { Category } from '../categories/entities/category.entity';
import { Product } from '../products/entities/product.entity';
import * as Papa from 'papaparse';
import { neutralizeCsvRows } from '../../common/csv/formula-injection';

@Injectable()
export class ExportsService {
  constructor(
    @InjectRepository(Category)
    private readonly categoryRepository: EntityRepository<Category>,
    @InjectRepository(Product)
    private readonly productRepository: EntityRepository<Product>,
  ) {}

  async exportCategories(organizationId: string): Promise<string> {
    // Scalability Note: This export runs completely in-memory using standard SQL queries and PapaParse.
    // Optimization techniques (like streaming, worker threads, and queue jobs) are intentionally deferred
    // as small/medium catalogues are the targeted workspace size.
    // P0-07: a tenant export never leaves its organization. P5-A2 canonical
    // family 7 makes the company REQUIRED — the conditional filter it replaced
    // returned every tenant's rows whenever the caller had no organization.
    const categories = await this.categoryRepository.find(
      { organization: organizationId },
      {
        populate: ['parentCategory'],
      },
    );

    const data = categories.map((cat) => ({
      name: cat.name || '',
      slug: cat.slug || '',
      description: cat.description || '',
      parentSlug: cat.parentCategory ? cat.parentCategory.slug : '',
    }));

    // Neutralize at the boundary: a name beginning `=`/`+`/`-`/`@`/tab/CR would
    // execute in the spreadsheet that opens this file. Stored bytes are untouched.
    return Papa.unparse(neutralizeCsvRows(data), {
      header: true,
      columns: ['name', 'slug', 'description', 'parentSlug'],
    });
  }

  async exportProducts(organizationId: string): Promise<string> {
    // Scalability Note: This export runs completely in-memory using standard SQL queries and PapaParse.
    // Optimization techniques (like streaming, worker threads, and queue jobs) are intentionally deferred
    // as small/medium catalogues are the targeted workspace size.
    const products = await this.productRepository.find(
      { organization: organizationId },
      {
        populate: ['categories'],
      },
    );

    // Note: nested image assets are intentionally excluded from CSV exports.
    // Family children are not "nested" anything — each is an ordinary product
    // and appears as its own row (ADR 018).
    const data = products.map((prod) => ({
      name: prod.name || '',
      slug: prod.slug || '',
      description: prod.description || '',
      sku: prod.sku || '',
      price: prod.price !== undefined && prod.price !== null ? String(prod.price) : '0',
      salePrice: prod.salePrice !== undefined && prod.salePrice !== null ? String(prod.salePrice) : '',
      cost: prod.cost !== undefined && prod.cost !== null ? String(prod.cost) : '',
      stockQuantity: prod.stockQuantity !== undefined && prod.stockQuantity !== null ? String(prod.stockQuantity) : '0',
      trackInventory: prod.trackInventory ? 'true' : 'false',
      status: prod.status || '',
      categorySlug: prod.categories
        .getItems()
        .map((c) => c.slug)
        .join('|'),
    }));

    return Papa.unparse(neutralizeCsvRows(data), {
      header: true,
      columns: [
        'name',
        'slug',
        'description',
        'sku',
        'price',
        'salePrice',
        'cost',
        'stockQuantity',
        'trackInventory',
        'status',
        'categorySlug',
      ],
    });
  }
}
