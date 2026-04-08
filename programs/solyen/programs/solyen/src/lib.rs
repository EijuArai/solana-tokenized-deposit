use {
    anchor_lang::{prelude::*, solana_program::program_error::ProgramError},
    anchor_spl::{
        token_2022::{
            spl_token_2022::{
                extension::{
                    transfer_hook::TransferHookAccount, BaseStateWithExtensions,
                    StateWithExtensions,
                },
                state::Account as Token2022Account,
            },
            ID as TOKEN_2022_PROGRAM_ID,
        },
        token_interface::{Mint, TokenAccount},
    },
    spl_discriminator::SplDiscriminate,
    spl_tlv_account_resolution::{account::ExtraAccountMeta, state::ExtraAccountMetaList},
    spl_transfer_hook_interface::{
        error::TransferHookError,
        instruction::{
            ExecuteInstruction, InitializeExtraAccountMetaListInstruction, TransferHookInstruction,
        },
    },
};

declare_id!("HzLFTDqqkeNzhrAB4rAPvTjzgjp2288stSmDLWQuKTNt");

fn check_token_account_is_transferring(account_data: &[u8]) -> Result<()> {
    let token_account = StateWithExtensions::<Token2022Account>::unpack(account_data)?;
    let extension = token_account.get_extension::<TransferHookAccount>()?;
    if bool::from(extension.transferring) {
        Ok(())
    } else {
        Err(Into::<ProgramError>::into(
            TransferHookError::ProgramCalledOutsideOfTransfer,
        ))?
    }
}

fn assert_wallets_whitelisted(
    registry: &WhitelistRegistry,
    source_wallet: &Pubkey,
    destination_wallet: &Pubkey,
) -> Result<()> {
    require!(
        registry.wallets.contains(source_wallet),
        SolyenError::WalletNotWhitelisted
    );
    require!(
        registry.wallets.contains(destination_wallet),
        SolyenError::WalletNotWhitelisted
    );
    Ok(())
}

#[program]
pub mod solyen {
    use super::*;

    pub fn initialize_registry(ctx: Context<InitializeRegistry>) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        registry.bump = ctx.bumps.registry;
        registry.authority = ctx.accounts.authority.key();
        registry.wallets = Vec::new();
        Ok(())
    }

    pub fn register_wallet(ctx: Context<UpdateRegistry>, wallet: Pubkey) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        if !registry.wallets.contains(&wallet) {
            registry.wallets.push(wallet);
        }
        Ok(())
    }

    pub fn unregister_wallet(ctx: Context<UpdateRegistry>, wallet: Pubkey) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        registry.wallets.retain(|candidate| *candidate != wallet);
        Ok(())
    }

    pub fn validate_transfer(
        ctx: Context<ValidateTransfer>,
        source_wallet: Pubkey,
        destination_wallet: Pubkey,
    ) -> Result<()> {
        assert_wallets_whitelisted(&ctx.accounts.registry, &source_wallet, &destination_wallet)
    }

    #[instruction(
        discriminator = InitializeExtraAccountMetaListInstruction::SPL_DISCRIMINATOR_SLICE
    )]
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        let mint_authority = ctx
            .accounts
            .mint
            .mint_authority
            .ok_or(Into::<ProgramError>::into(
                TransferHookError::MintHasNoMintAuthority,
            ))?;
        if mint_authority != ctx.accounts.authority.key() {
            Err(Into::<ProgramError>::into(
                TransferHookError::IncorrectMintAuthority,
            ))?;
        }

        let registry_meta = ExtraAccountMeta {
            discriminator: 0,
            address_config: ctx.accounts.registry.key().to_bytes(),
            is_signer: false.into(),
            is_writable: false.into(),
        };

        let mut data = ctx.accounts.extra_metas_account.try_borrow_mut_data()?;
        ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &[registry_meta])?;
        Ok(())
    }

    #[instruction(discriminator = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn execute(ctx: Context<Execute>, amount: u64) -> Result<()> {
        let source_account = &ctx.accounts.source_account;
        let destination_account = &ctx.accounts.destination_account;

        check_token_account_is_transferring(&source_account.to_account_info().try_borrow_data()?)?;
        check_token_account_is_transferring(
            &destination_account.to_account_info().try_borrow_data()?,
        )?;

        let data = ctx.accounts.extra_metas_account.try_borrow_data()?;
        ExtraAccountMetaList::check_account_infos::<ExecuteInstruction>(
            &ctx.accounts.to_account_infos(),
            &TransferHookInstruction::Execute { amount }.pack(),
            &ctx.program_id,
            &data,
        )?;

        assert_wallets_whitelisted(
            &ctx.accounts.registry,
            &source_account.owner,
            &destination_account.owner,
        )
    }
}

#[derive(Accounts)]
pub struct InitializeRegistry<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        seeds = [b"registry"],
        bump,
        space = 8 + 1 + 32 + 4 + (32 * 64)
    )]
    pub registry: Account<'info, WhitelistRegistry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateRegistry<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"registry"],
        bump = registry.bump,
        has_one = authority
    )]
    pub registry: Account<'info, WhitelistRegistry>,
}

#[derive(Accounts)]
pub struct ValidateTransfer<'info> {
    pub registry: Account<'info, WhitelistRegistry>,
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    /// CHECK: This account stores TLV extra account metadata for the transfer hook.
    #[account(
        init,
        payer = authority,
        space = ExtraAccountMetaList::size_of(1).unwrap(),
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        bump,
    )]
    pub extra_metas_account: UncheckedAccount<'info>,
    #[account(
        mint::token_program = TOKEN_2022_PROGRAM_ID,
        extensions::transfer_hook::authority = authority,
        extensions::transfer_hook::program_id = crate::ID,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"registry"],
        bump = registry.bump,
    )]
    pub registry: Account<'info, WhitelistRegistry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Execute<'info> {
    #[account(
        token::mint = mint,
        token::authority = owner_delegate,
        token::token_program = TOKEN_2022_PROGRAM_ID,
    )]
    pub source_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mint::token_program = TOKEN_2022_PROGRAM_ID,
        extensions::transfer_hook::program_id = crate::ID,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        token::mint = mint,
        token::token_program = TOKEN_2022_PROGRAM_ID,
    )]
    pub destination_account: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: The token program validates this account as the transfer authority or delegate.
    pub owner_delegate: UncheckedAccount<'info>,
    /// CHECK: This account stores TLV extra account metadata for the transfer hook.
    #[account(
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        bump,
    )]
    pub extra_metas_account: UncheckedAccount<'info>,
    #[account(
        seeds = [b"registry"],
        bump = registry.bump,
    )]
    pub registry: Account<'info, WhitelistRegistry>,
}

#[account]
pub struct WhitelistRegistry {
    pub bump: u8,
    pub authority: Pubkey,
    pub wallets: Vec<Pubkey>,
}

#[error_code]
pub enum SolyenError {
    #[msg("Wallet is not whitelisted")]
    WalletNotWhitelisted,
}
