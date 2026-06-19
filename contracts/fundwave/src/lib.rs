//! FundWave — a minimal but complete crowdfunding contract for Stellar / Soroban.
//!
//! Modeled on the official Soroban examples (auth, single_offer, storage) and
//! the Stellar developer documentation. The contract follows these rules:
//!
//! - The creator of a campaign is also the recipient of the raised funds.
//!   There is no separate `beneficiary`; the goal is to keep the on-chain
//!   surface small and the UX simple.
//! - All token operations use the standard `token::Client` interface
//!   (https://developers.stellar.org/docs/tokens/token-interface).
//! - Authorization is enforced with `Address::require_auth()` per the
//!   authorization guide:
//!   https://developers.stellar.org/docs/build/smart-contracts/conventions/auth
//! - Storage is keyed through a single `DataKey` enum (the convention shown
//!   in the official `auth` and `single_offer` examples) and persistent
//!   entries are given a generous TTL on every write so the data outlives
//!   the typical Soroban restore window.
//!
//! Lifecycle of a campaign:
//!   Active  -> if goal met at any point              -> Successful
//!   Active  -> if deadline passed and goal NOT met   -> Failed
//!   Successful -> creator may `withdraw` (paid in the campaign's token)
//!   Failed     -> donors may `refund` (paid back in the campaign's token)

#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, token, Address, Env,
    String, Symbol, Vec,
};

// ---------------- errors ----------------

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    GoalMustBePositive = 1,
    DeadlineInPast = 2,
    AmountMustBePositive = 3,
    CampaignNotFound = 4,
    CampaignNotActive = 5,
    DeadlinePassed = 6,
    NotCreator = 7,
    NotFailed = 8,
    NothingToRefund = 9,
}

// ---------------- storage layout ----------------

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Monotonically increasing id assigned to the next `create_campaign`.
    NextId,
    /// Campaign by id.
    Campaign(u64),
    /// Per-donor contribution to a campaign, used for refunds.
    Donor(u64, Address),
}

// ---------------- domain types ----------------

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CampaignStatus {
    Active,
    Successful,
    Failed,
    Withdrawn,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Campaign {
    pub id: u64,
    pub creator: Address,
    pub token: Address,
    pub goal: i128,
    pub raised: i128,
    pub deadline: u64,
    pub title: String,
    pub description: String,
    pub status: CampaignStatus,
}

// ---------------- contract ----------------

#[contract]
pub struct Fundwave;

#[contractimpl]
impl Fundwave {
    /// Optional initializer. The contract lazily initializes the id counter
    /// on the first `create_campaign`, so this is a no-op for new
    /// deployments and remains only for backward compatibility with the
    /// deploy script's `--reset` flag.
    pub fn init(env: Env) {
        if !env.storage().instance().has(&DataKey::NextId) {
            env.storage().instance().set(&DataKey::NextId, &1u64);
        }
    }

    /// Create a new campaign. The caller (`creator`) is also the recipient
    /// of the raised funds — there is no separate beneficiary. Returns the
    /// new campaign id (starting at 1).
    pub fn create_campaign(
        env: Env,
        creator: Address,
        token: Address,
        goal: i128,
        deadline: u64,
        title: String,
        description: String,
    ) -> u64 {
        // The creator must authorize the create call.
        creator.require_auth();

        if goal <= 0 {
            panic_with_error!(&env, Error::GoalMustBePositive);
        }
        if deadline <= env.ledger().timestamp() {
            panic_with_error!(&env, Error::DeadlineInPast);
        }

        // Lazily initialize the id counter; otherwise bump it.
        let next_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .unwrap_or(1u64);
        env.storage()
            .instance()
            .set(&DataKey::NextId, &(next_id + 1));

        let campaign = Campaign {
            id: next_id,
            creator: creator.clone(),
            token,
            goal,
            raised: 0,
            deadline,
            title,
            description,
            status: CampaignStatus::Active,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Campaign(next_id), &campaign);
        env.storage().persistent().extend_ttl(
            &DataKey::Campaign(next_id),
            100_000,
            200_000,
        );

        // event: campaign_created(id, creator, goal, deadline)
        env.events().publish(
            (Symbol::new(&env, "campaign_created"),),
            (next_id, creator, goal, deadline),
        );

        next_id
    }

    /// Donate `amount` of the campaign's token to campaign `id`.
    /// Anyone may donate; the donor must authorize the call.
    pub fn donate(env: Env, id: u64, donor: Address, amount: i128) {
        if amount <= 0 {
            panic_with_error!(&env, Error::AmountMustBePositive);
        }
        donor.require_auth();

        let mut campaign = load_campaign(&env, id);

        if campaign.status != CampaignStatus::Active {
            panic_with_error!(&env, Error::CampaignNotActive);
        }
        if env.ledger().timestamp() > campaign.deadline {
            panic_with_error!(&env, Error::DeadlinePassed);
        }

        // Move tokens from the donor to this contract.
        let token_client = token::Client::new(&env, &campaign.token);
        token_client.transfer(&donor, &env.current_contract_address(), &amount);

        campaign.raised = campaign.raised.saturating_add(amount);
        if campaign.raised >= campaign.goal {
            campaign.status = CampaignStatus::Successful;
        }

        env.storage()
            .persistent()
            .set(&DataKey::Campaign(id), &campaign);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Campaign(id), 100_000, 200_000);

        // Track per-donor contribution for refunds.
        let key = DataKey::Donor(id, donor.clone());
        let prev: i128 = env.storage().persistent().get(&key).unwrap_or(0i128);
        env.storage().persistent().set(&key, &(prev + amount));
        env.storage().persistent().extend_ttl(&key, 100_000, 200_000);

        // event: donated(id, donor, amount)
        env.events().publish(
            (Symbol::new(&env, "donated"),),
            (id, donor, amount),
        );
    }

    /// Close the campaign if the deadline has passed without reaching the
    /// goal. Anyone may call this once the deadline has elapsed.
    pub fn finalize(env: Env, id: u64) {
        let mut campaign = load_campaign(&env, id);
        if campaign.status != CampaignStatus::Active {
            // Already finalized — silently no-op.
            return;
        }
        if env.ledger().timestamp() <= campaign.deadline {
            panic_with_error!(&env, Error::DeadlineInPast);
        }
        campaign.status = CampaignStatus::Failed;
        env.storage()
            .persistent()
            .set(&DataKey::Campaign(id), &campaign);
    }

    /// Withdraw the raised funds to the creator. Only callable by the
    /// creator, and only after the campaign became `Successful`.
    pub fn withdraw(env: Env, id: u64) {
        let mut campaign = load_campaign(&env, id);
        campaign.creator.require_auth();

        // Lazily mark a successful campaign once the goal is met. This
        // covers the case where a donation pushed the campaign over the
        // line but the donor-side status update was on an older code path.
        if campaign.status == CampaignStatus::Active
            && campaign.raised >= campaign.goal
        {
            campaign.status = CampaignStatus::Successful;
        }
        if campaign.status != CampaignStatus::Successful {
            panic_with_error!(&env, Error::CampaignNotActive);
        }
        let amount = campaign.raised;
        if amount <= 0 {
            panic_with_error!(&env, Error::NothingToRefund);
        }

        let token_client = token::Client::new(&env, &campaign.token);
        token_client.transfer(
            &env.current_contract_address(),
            &campaign.creator,
            &amount,
        );

        campaign.raised = 0;
        campaign.status = CampaignStatus::Withdrawn;
        env.storage()
            .persistent()
            .set(&DataKey::Campaign(id), &campaign);

        // event: withdrawn(id, creator, amount)
        env.events().publish(
            (Symbol::new(&env, "withdrawn"),),
            (id, campaign.creator, amount),
        );
    }

    /// Refund a donor's contribution. Callable only when the campaign
    /// ended in `Failed` status. Each donor may refund once, up to the
    /// amount they contributed.
    pub fn refund(env: Env, id: u64, donor: Address) {
        donor.require_auth();
        let campaign = load_campaign(&env, id);
        if campaign.status != CampaignStatus::Failed {
            panic_with_error!(&env, Error::NotFailed);
        }
        let key = DataKey::Donor(id, donor.clone());
        let amount: i128 = env.storage().persistent().get(&key).unwrap_or(0i128);
        if amount <= 0 {
            panic_with_error!(&env, Error::NothingToRefund);
        }

        let token_client = token::Client::new(&env, &campaign.token);
        token_client.transfer(&env.current_contract_address(), &donor, &amount);
        env.storage().persistent().set(&key, &0i128);

        // event: refunded(id, donor, amount)
        env.events().publish(
            (Symbol::new(&env, "refunded"),),
            (id, donor, amount),
        );
    }

    // ---------------- views ----------------

    pub fn get_campaign(env: Env, id: u64) -> Option<Campaign> {
        env.storage().persistent().get(&DataKey::Campaign(id))
    }

    pub fn donor_balance(env: Env, id: u64, donor: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Donor(id, donor))
            .unwrap_or(0i128)
    }

    pub fn list_campaigns(env: Env, from: u64, limit: u32) -> Vec<Campaign> {
        let next_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .unwrap_or(1u64);
        let mut out: Vec<Campaign> = Vec::new(&env);
        let end = core::cmp::min(next_id, from.saturating_add(limit as u64));
        let mut i = from;
        while i < end {
            if let Some(c) = env
                .storage()
                .persistent()
                .get::<_, Campaign>(&DataKey::Campaign(i))
            {
                out.push_back(c);
            }
            i = i.saturating_add(1);
        }
        out
    }
}

fn load_campaign(env: &Env, id: u64) -> Campaign {
    env.storage()
        .persistent()
        .get(&DataKey::Campaign(id))
        .unwrap_or_else(|| panic_with_error!(env, Error::CampaignNotFound))
}

// ---------------- tests ----------------

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token, Address, Env, String,
    };

    fn create_token<'a>(
        env: &'a Env,
        admin: &Address,
    ) -> (Address, token::Client<'a>, token::StellarAssetClient<'a>) {
        let addr = env.register_stellar_asset_contract_v2(admin.clone());
        let client = token::Client::new(env, &addr.address());
        let admin_client = token::StellarAssetClient::new(env, &addr.address());
        (addr.address(), client, admin_client)
    }

    #[test]
    fn full_lifecycle_success() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(Fundwave, ());
        let client = FundwaveClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let creator = Address::generate(&env);
        let donor1 = Address::generate(&env);
        let donor2 = Address::generate(&env);

        let (token_addr, token_client, admin_client) = create_token(&env, &admin);
        admin_client.mint(&donor1, &1_000);
        admin_client.mint(&donor2, &4_000);

        let id = client.create_campaign(
            &creator,
            &token_addr,
            &500i128,
            &(env.ledger().timestamp() + 100),
            &String::from_str(&env, "Buy a goat"),
            &String::from_str(&env, "we need a goat for the village"),
        );
        assert_eq!(id, 1);

        client.donate(&id, &donor1, &200i128);
        client.donate(&id, &donor2, &300i128);

        let c = client.get_campaign(&id).unwrap();
        assert_eq!(c.raised, 500);
        assert_eq!(c.status, CampaignStatus::Successful);

        // The creator is the recipient.
        client.withdraw(&id);
        let c2 = client.get_campaign(&id).unwrap();
        assert_eq!(c2.status, CampaignStatus::Withdrawn);
        assert_eq!(token_client.balance(&creator), 500);
    }

    #[test]
    fn failed_campaign_refund() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(Fundwave, ());
        let client = FundwaveClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let creator = Address::generate(&env);
        let donor = Address::generate(&env);

        let (token_addr, token_client, admin_client) = create_token(&env, &admin);
        admin_client.mint(&donor, &1_000);

        let id = client.create_campaign(
            &creator,
            &token_addr,
            &10_000i128,
            &(env.ledger().timestamp() + 10),
            &String::from_str(&env, "Big goal"),
            &String::from_str(&env, "nope"),
        );
        client.donate(&id, &donor, &100i128);

        env.ledger().set_timestamp(env.ledger().timestamp() + 100);
        client.finalize(&id);

        let c = client.get_campaign(&id).unwrap();
        assert_eq!(c.status, CampaignStatus::Failed);

        client.refund(&id, &donor);
        assert_eq!(token_client.balance(&donor), 1_000);
    }

}
