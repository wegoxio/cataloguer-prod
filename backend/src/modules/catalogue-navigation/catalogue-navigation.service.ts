import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql';
import { CatalogueChannel } from './entities/catalogue-channel.entity';
import { CatalogueGroup } from './entities/catalogue-group.entity';
import { StoreCategoryPublication } from './entities/store-category-publication.entity';
import { CatalogueGroupCategory } from './entities/catalogue-group-category.entity';
import { Store } from '../stores/entities/store.entity';
import { Category } from '../categories/entities/category.entity';
import { Product } from '../products/entities/product.entity';
import {
  CreateChannelDto,
  CreateGroupDto,
  ReorderGroupsDto,
  SetGroupCategoriesDto,
  UpdateChannelDto,
  UpdateGroupDto,
  UpsertCategoryPublicationDto,
} from './dto/catalogue-navigation.dto';

@Injectable()
export class CatalogueNavigationService {
  constructor(
    @InjectRepository(CatalogueChannel) private readonly channels: EntityRepository<CatalogueChannel>,
    @InjectRepository(CatalogueGroup) private readonly groups: EntityRepository<CatalogueGroup>,
    @InjectRepository(StoreCategoryPublication)
    private readonly publications: EntityRepository<StoreCategoryPublication>,
    @InjectRepository(CatalogueGroupCategory)
    private readonly groupCategories: EntityRepository<CatalogueGroupCategory>,
    private readonly em: EntityManager,
  ) {}

  private async context(organizationId: string, storeId: string) {
    const store = await this.em.findOne(Store, { id: storeId, organization: organizationId, archivedAt: null });
    if (!store) throw new NotFoundException('Store not found');
    return { store, organizationId };
  }

  private async channelIn(organizationId: string, storeId: string, id: string) {
    const channel = await this.channels.findOne({ id, organization: organizationId, store: storeId });
    if (!channel) throw new NotFoundException('Catalogue channel not found');
    return channel;
  }

  private async groupIn(organizationId: string, storeId: string, id: string) {
    const group = await this.groups.findOne(
      { id, organization: organizationId, store: storeId },
      { populate: ['channel'] },
    );
    if (!group) throw new NotFoundException('Catalogue group not found');
    return group;
  }

  async snapshot(organizationId: string, storeId: string) {
    await this.context(organizationId, storeId);
    const [channels, groups, publications, memberships] = await Promise.all([
      this.channels.find(
        { organization: organizationId, store: storeId },
        { orderBy: { sortOrder: 'asc', name: 'asc' } },
      ),
      this.groups.find(
        { organization: organizationId, store: storeId },
        { populate: ['channel'], orderBy: { sortOrder: 'asc', name: 'asc' } },
      ),
      this.publications.find(
        { organization: organizationId, store: storeId },
        { populate: ['channel', 'category', 'coverProduct'], orderBy: { sortOrder: 'asc' } },
      ),
      this.groupCategories.find(
        { organization: organizationId, store: storeId },
        { populate: ['group', 'category'], orderBy: { sortOrder: 'asc' } },
      ),
    ]);
    return {
      channels,
      groups,
      publications,
      memberships: memberships.map((entry) => ({
        id: entry.id,
        groupId: entry.group.id,
        categoryId: entry.category.id,
        sortOrder: entry.sortOrder,
      })),
    };
  }

  async createChannel(organizationId: string, storeId: string, dto: CreateChannelDto) {
    const { store } = await this.context(organizationId, storeId);
    if (await this.channels.findOne({ store: storeId, key: dto.key }))
      throw new BadRequestException('Channel key already exists');
    if (dto.isDefault) await this.channels.nativeUpdate({ store: storeId, isDefault: true }, { isDefault: false });
    const channel = this.channels.create({
      organization: organizationId as any,
      store,
      key: dto.key,
      name: dto.name,
      description: dto.description ?? null,
      isDefault: dto.isDefault ?? false,
      active: dto.active ?? true,
      sortOrder: dto.sortOrder ?? 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await this.em.persistAndFlush(channel);
    return channel;
  }

  async updateChannel(organizationId: string, storeId: string, id: string, dto: UpdateChannelDto) {
    const channel = await this.channelIn(organizationId, storeId, id);
    if (dto.isDefault) await this.channels.nativeUpdate({ store: storeId, isDefault: true }, { isDefault: false });
    this.channels.assign(channel, dto);
    await this.em.flush();
    return channel;
  }

  async createGroup(organizationId: string, storeId: string, channelId: string, dto: CreateGroupDto) {
    const channel = await this.channelIn(organizationId, storeId, channelId);
    if (await this.groups.findOne({ channel, key: dto.key }))
      throw new BadRequestException('Group key already exists in this channel');
    const coverProduct = dto.coverProductId
      ? await this.validCoverProduct(organizationId, storeId, dto.coverProductId)
      : null;
    const group = this.groups.create({
      organization: organizationId as any,
      store: storeId as any,
      channel,
      key: dto.key,
      name: dto.name,
      description: dto.description ?? null,
      purpose: dto.purpose ?? 'FILTER',
      placements: dto.placements ?? [],
      coverProduct,
      active: dto.active ?? true,
      sortOrder: dto.sortOrder ?? 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await this.em.persistAndFlush(group);
    return group;
  }

  async updateGroup(organizationId: string, storeId: string, id: string, dto: UpdateGroupDto) {
    const group = await this.groupIn(organizationId, storeId, id);
    const { coverProductId, ...values } = dto;
    this.groups.assign(group, values);
    if (coverProductId !== undefined)
      group.coverProduct = coverProductId
        ? await this.validCoverProduct(organizationId, storeId, coverProductId)
        : null;
    await this.em.flush();
    return group;
  }

  async reorderNavigationGroups(organizationId: string, storeId: string, channelId: string, dto: ReorderGroupsDto) {
    const channel = await this.channelIn(organizationId, storeId, channelId);
    const groups = await this.groups.find(
      { organization: organizationId, store: storeId, channel, purpose: 'NAVIGATION', active: true },
      { orderBy: { sortOrder: 'asc', name: 'asc', id: 'asc' } },
    );
    const availableIds = new Set(groups.map((group) => group.id));
    if (dto.groupIds.length !== groups.length || dto.groupIds.some((id) => !availableIds.has(id))) {
      throw new BadRequestException(
        'The order must contain every active navigation group in this channel exactly once',
      );
    }
    const visibleIds = dto.visibleGroupIds ? new Set(dto.visibleGroupIds) : null;
    if (visibleIds && [...visibleIds].some((id) => !availableIds.has(id))) {
      throw new BadRequestException('Every visible group must belong to this navigation channel');
    }
    const byId = new Map(groups.map((group) => [group.id, group]));
    dto.groupIds.forEach((id, sortOrder) => {
      const group = byId.get(id)!;
      group.sortOrder = sortOrder;
      if (visibleIds) {
        const placements = new Set(group.placements);
        if (visibleIds.has(id)) placements.add('CATALOG');
        else placements.delete('CATALOG');
        group.placements = [...placements];
      }
      group.updatedAt = new Date();
    });
    await this.em.flush();
    return this.snapshot(organizationId, storeId);
  }

  private async validCoverProduct(organizationId: string, storeId: string, productId: string) {
    const product = await this.em.findOne(Product, {
      id: productId,
      organization: organizationId,
      archivedAt: null,
      branchLinks: { store: storeId, published: true },
    });
    if (!product) throw new BadRequestException('Cover product must be published in this store');
    return product;
  }

  async setGroupCategories(organizationId: string, storeId: string, id: string, dto: SetGroupCategoriesDto) {
    const group = await this.groupIn(organizationId, storeId, id);
    const categories = dto.categoryIds.length
      ? await this.em.find(Category, { id: { $in: dto.categoryIds }, organization: organizationId, archivedAt: null })
      : [];
    if (categories.length !== new Set(dto.categoryIds).size)
      throw new BadRequestException('One or more categories are unavailable');
    const published = dto.categoryIds.length
      ? await this.publications.find({
          store: storeId,
          channel: group.channel.id,
          category: { $in: dto.categoryIds },
          visible: true,
        })
      : [];
    if (published.length !== categories.length)
      throw new BadRequestException('Every grouped category must be published in the same channel first');
    await this.groupCategories.nativeDelete({ group });
    categories.forEach((category, sortOrder) =>
      this.em.persist(
        this.groupCategories.create({
          organization: organizationId as any,
          store: storeId as any,
          group,
          category,
          sortOrder,
          createdAt: new Date(),
        }),
      ),
    );
    await this.em.flush();
    return this.snapshot(organizationId, storeId);
  }

  async addCategoryToNavigation(
    organizationId: string,
    storeId: string,
    channelId: string,
    categoryId: string,
  ) {
    const groupId = await this.em.transactional(async (em) => {
      const channel = await em.findOne(CatalogueChannel, {
        id: channelId,
        organization: organizationId,
        store: storeId,
        active: true,
      });
      if (!channel) throw new NotFoundException('Catalogue channel not found');
      const category = await em.findOne(Category, {
        id: categoryId,
        organization: organizationId,
        archivedAt: null,
      });
      if (!category) throw new NotFoundException('Category not found');

      let publication = await em.findOne(StoreCategoryPublication, { store: storeId, channel, category });
      if (!publication) {
        publication = em.create(StoreCategoryPublication, {
          organization: organizationId as any,
          store: storeId as any,
          channel,
          category,
          visible: true,
          placements: ['HOME', 'CATALOG', 'NAVIGATION'],
          sortOrder: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        em.persist(publication);
      } else {
        publication.visible = true;
        publication.placements = [
          ...new Set([...publication.placements, 'HOME', 'CATALOG', 'NAVIGATION'] as const),
        ];
        publication.updatedAt = new Date();
      }

      const existingMembership = await em.findOne(
        CatalogueGroupCategory,
        {
          organization: organizationId,
          store: storeId,
          category,
          group: { channel, purpose: 'NAVIGATION', active: true },
        },
        { populate: ['group'] },
      );
      if (existingMembership) {
        const existingGroup = existingMembership.group;
        existingGroup.placements = [...new Set([...existingGroup.placements, 'CATALOG'] as const)];
        existingGroup.updatedAt = new Date();
        await em.flush();
        return existingGroup.id;
      }

      const existingGroups = await em.find(
        CatalogueGroup,
        { organization: organizationId, store: storeId, channel },
        { orderBy: { sortOrder: 'desc', id: 'asc' } },
      );
      const existingKeys = new Set(existingGroups.map((group) => group.key));
      const baseKey = category.slug.slice(0, 80);
      let key = baseKey;
      let suffix = 2;
      while (existingKeys.has(key)) {
        const ending = `-${suffix++}`;
        key = `${baseKey.slice(0, 80 - ending.length)}${ending}`;
      }
      const navigationSortOrders = existingGroups
        .filter((group) => group.purpose === 'NAVIGATION' && group.active)
        .map((group) => group.sortOrder);
      const group = em.create(CatalogueGroup, {
        organization: organizationId as any,
        store: storeId as any,
        channel,
        key,
        name: category.publicLabel?.trim() || category.name,
        purpose: 'NAVIGATION',
        placements: ['HOME', 'CATALOG', 'NAVIGATION'],
        active: true,
        sortOrder: navigationSortOrders.length ? Math.max(...navigationSortOrders) + 1 : 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      em.persist(group);
      em.persist(em.create(CatalogueGroupCategory, {
        organization: organizationId as any,
        store: storeId as any,
        group,
        category,
        sortOrder: 0,
        createdAt: new Date(),
      }));
      await em.flush();
      return group.id;
    });
    return { groupId };
  }

  async upsertPublication(
    organizationId: string,
    storeId: string,
    channelId: string,
    categoryId: string,
    dto: UpsertCategoryPublicationDto,
  ) {
    const channel = await this.channelIn(organizationId, storeId, channelId);
    const category = await this.em.findOne(Category, {
      id: categoryId,
      organization: organizationId,
      archivedAt: null,
    });
    if (!category) throw new NotFoundException('Category not found');
    let coverProduct: Product | null = null;
    if (dto.coverProductId) {
      coverProduct = await this.em.findOne(Product, {
        id: dto.coverProductId,
        organization: organizationId,
        archivedAt: null,
        categories: categoryId,
        branchLinks: { store: storeId, published: true },
      });
      if (!coverProduct)
        throw new BadRequestException('Cover product must be a published product assigned to this category');
    }
    let publication = await this.publications.findOne({ store: storeId, channel, category });
    if (!publication) {
      publication = this.publications.create({
        organization: organizationId as any,
        store: storeId as any,
        channel,
        category,
        placements: [],
        visible: true,
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      this.em.persist(publication);
    }
    if (dto.visible !== undefined) publication.visible = dto.visible;
    if (dto.placements !== undefined) publication.placements = dto.placements;
    if (dto.publicLabel !== undefined) publication.publicLabel = dto.publicLabel?.trim() || null;
    if (dto.sortOrder !== undefined) publication.sortOrder = dto.sortOrder;
    if (dto.coverProductId !== undefined) publication.coverProduct = coverProduct;
    await this.em.flush();
    return publication;
  }
}
