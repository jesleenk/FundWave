//! FundWave — a minimal but complete crowdfunding contract for Stellar / Soroban.
//!
//! Storage layout:
//!   Campaign(id)        -> Campaign
//!   NextId              -> u64
//!   DonorBal(id, donor) -> i128   (cumulative amount donated by `donor`)
//!   DonorCount(id)      -> u32    (number of distinct donors)
//!   DonorIdx(id, idx)   -> Address
//!
//! Lifecycle of a campaign:
//!   Active  -> if goal met at any point        -> Successful
//!   Active  -> if deadline passed and goal NOT met -> Failed
//!   Successful -> creator may `withdraw`
//!   Failed     -> donors may `refund`

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype,
    token::TokenClient,
    Address, Env, String, Symbol, Vec,
};

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
    pub beneficiary: Address,
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
    /// Initialize the contract. Id counter starts at 1.
    pub fn init(env: Env) {
        if !env
            .storage()
            .instance()
            .has(&Symbol::new(&env, "NextId"))
        {
            env.storage()
                .instance()
                .set(&Symbol::new(&env, "NextId"), &1u64);
        }
    }

    /// Create a new campaign. Returns the new campaign id.
    #[allow(clippy::too_many_arguments)]
    pub fn create_campaign(
        env: Env,
        creator: Address,
        beneficiary: Address,
        token: Address,
        goal: i128,
        deadline: u64,
        title: String,
        description: String,
    ) -> u64 {
        creator.require_auth();
        if goal <= 0 {
            panic!("goal must be > 0");
        }
        if deadline <= env.ledger().timestamp() {
            panic!("deadline must be in the future");
        }

        let next_id: u64 = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "NextId"))
            .unwrap_or(1u64);
        let id = next_id;
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "NextId"), &(next_id + 1));

        let campaign = Campaign {
            id,
            creator: creator.clone(),
            beneficiary,
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
            .set(&campaign_key(&env, id), &campaign);
        env.storage()
            .persistent()
            .extend_ttl(&campaign_key(&env, id), 100_000, 200_000);

        // event: campaign_created(id, creator, goal, deadline)
        let topics: Vec<Symbol> = Vec::from_array(
            &env,
            [
                Symbol::new(&env, "campaign_created"),
                Symbol::new(&env, "id"),
            ],
        );
        env.events().publish(
            topics,
            (id, creator, goal, deadline),
        );

        id
    }

    /// Donate `amount` of `token` to campaign `id` from `donor`.
    pub fn donate(env: Env, id: u64, donor: Address, amount: i128) {
        if amount <= 0 {
            panic!("amount must be > 0");
        }
        donor.require_auth();

        let mut campaign = load_campaign(&env, id);
        if !matches!(campaign.status, CampaignStatus::Active) {
            panic!("campaign is not active");
        }
        if env.ledger().timestamp() > campaign.deadline {
            panic!("campaign deadline passed");
        }

        // Transfer tokens from donor to this contract.
        let token_client = TokenClient::new(&env, &campaign.token);
        token_client.transfer(&donor, &env.current_contract_address(), &amount);

        campaign.raised = campaign.raised.saturating_add(amount);
        env.storage()
            .persistent()
            .set(&campaign_key(&env, id), &campaign);
        env.storage()
            .persistent()
            .extend_ttl(&campaign_key(&env, id), 100_000, 200_000);

        // Track per-donor contribution for refunds.
        let donor_key = donor_balance_key(&env, id, &donor);
        let prev: i128 = env.storage().persistent().get(&donor_key).unwrap_or(0i128);
        if prev == 0 {
            let count_key = donor_count_key(&env, id);
            let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0u32);
            env.storage()
                .persistent()
                .set(&donor_index_key(&env, id, count), &donor);
            env.storage().persistent().set(&count_key, &(count + 1));
        }
        env.storage()
            .persistent()
            .set(&donor_key, &(prev + amount));
        env.storage()
            .persistent()
            .extend_ttl(&donor_key, 100_000, 200_000);

        // event: donation_made(id, donor, amount, new_total)
        let topics: Vec<Symbol> = Vec::from_array(
            &env,
            [
                Symbol::new(&env, "donation_made"),
                Symbol::new(&env, "id"),
            ],
        );
        env.events()
            .publish(topics, (id, donor.clone(), amount, campaign.raised));

        // Auto-finalize if goal is reached.
        if campaign.raised >= campaign.goal {
            campaign.status = CampaignStatus::Successful;
            env.storage()
                .persistent()
                .set(&campaign_key(&env, id), &campaign);
            let topics: Vec<Symbol> = Vec::from_array(
                &env,
                [
                    Symbol::new(&env, "campaign_finalized"),
                    Symbol::new(&env, "id"),
                ],
            );
            env.events()
                .publish(topics, (id, true));
        }
    }

    /// Finalize a campaign after its deadline has passed.
    pub fn finalize(env: Env, id: u64) {
        let mut campaign = load_campaign(&env, id);
        if matches!(campaign.status, CampaignStatus::Withdrawn) {
            panic!("already withdrawn");
        }
        if env.ledger().timestamp() <= campaign.deadline {
            panic!("deadline not reached");
        }
        if matches!(
            campaign.status,
            CampaignStatus::Successful | CampaignStatus::Failed
        ) {
            return;
        }

        if campaign.raised >= campaign.goal {
            campaign.status = CampaignStatus::Successful;
        } else {
            campaign.status = CampaignStatus::Failed;
        }
        env.storage()
            .persistent()
            .set(&campaign_key(&env, id), &campaign);

        let topics: Vec<Symbol> = Vec::from_array(
            &env,
            [
                Symbol::new(&env, "campaign_finalized"),
                Symbol::new(&env, "id"),
            ],
        );
        env.events()
            .publish(topics, (id, campaign.raised >= campaign.goal));
    }

    /// Creator withdraws raised funds once the campaign succeeded.
    pub fn withdraw(env: Env, id: u64) {
        let mut campaign = load_campaign(&env, id);
        if matches!(campaign.status, CampaignStatus::Active) {
            if env.ledger().timestamp() > campaign.deadline
                && campaign.raised < campaign.goal
            {
                campaign.status = CampaignStatus::Failed;
                env.storage()
                    .persistent()
                    .set(&campaign_key(&env, id), &campaign);
            }
        }
        if !matches!(campaign.status, CampaignStatus::Successful) {
            panic!("campaign not successful");
        }
        campaign.creator.require_auth();

        let amount = campaign.raised;
        let token_client = TokenClient::new(&env, &campaign.token);
        token_client.transfer(
            &env.current_contract_address(),
            &campaign.beneficiary,
            &amount,
        );

        campaign.status = CampaignStatus::Withdrawn;
        campaign.raised = 0;
        env.storage()
            .persistent()
            .set(&campaign_key(&env, id), &campaign);

        let topics: Vec<Symbol> = Vec::from_array(
            &env,
            [Symbol::new(&env, "withdrawal"), Symbol::new(&env, "id")],
        );
        env.events()
            .publish(topics, (id, campaign.beneficiary.clone(), amount));
    }

    /// Donor claims a refund on a Failed campaign.
    pub fn refund(env: Env, id: u64, donor: Address) {
        donor.require_auth();
        let campaign = load_campaign(&env, id);
        if !matches!(campaign.status, CampaignStatus::Failed) {
            panic!("refunds only available for failed campaigns");
        }
        let donor_key = donor_balance_key(&env, id, &donor);
        let amount: i128 = env.storage().persistent().get(&donor_key).unwrap_or(0i128);
        if amount <= 0 {
            panic!("nothing to refund");
        }

        let token_client = TokenClient::new(&env, &campaign.token);
        token_client.transfer(&env.current_contract_address(), &donor, &amount);
        env.storage().persistent().remove(&donor_key);

        let topics: Vec<Symbol> = Vec::from_array(
            &env,
            [Symbol::new(&env, "refund_issued"), Symbol::new(&env, "id")],
        );
        env.events()
            .publish(topics, (id, donor.clone(), amount));
    }

    // ---------------- views ----------------

    pub fn get_campaign(env: Env, id: u64) -> Option<Campaign> {
        env.storage().persistent().get(&campaign_key(&env, id))
    }

    pub fn donor_balance(env: Env, id: u64, donor: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&donor_balance_key(&env, id, &donor))
            .unwrap_or(0i128)
    }

    pub fn list_campaigns(env: Env, from: u64, limit: u32) -> Vec<Campaign> {
        let next_id: u64 = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "NextId"))
            .unwrap_or(1u64);
        let mut out: Vec<Campaign> = Vec::new(&env);
        let end = core::cmp::min(next_id, from.saturating_add(limit as u64));
        let mut i = from;
        while i < end {
            if let Some(c) = env
                .storage()
                .persistent()
                .get::<_, Campaign>(&campaign_key(&env, i))
            {
                out.push_back(c);
            }
            i = i.saturating_add(1);
        }
        out
    }
}

// ---------------- helpers ----------------

fn campaign_key(env: &Env, id: u64) -> (Symbol, u64) {
    (Symbol::new(env, "Campaign"), id)
}

fn donor_balance_key(env: &Env, id: u64, donor: &Address) -> (Symbol, u64, Address) {
    (Symbol::new(env, "DonorBal"), id, donor.clone())
}

fn donor_count_key(env: &Env, id: u64) -> (Symbol, u64) {
    (Symbol::new(env, "DonorCount"), id)
}

fn donor_index_key(env: &Env, id: u64, idx: u32) -> (Symbol, u64, u32) {
    (Symbol::new(env, "DonorIdx"), id, idx)
}

fn load_campaign(env: &Env, id: u64) -> Campaign {
    env.storage()
        .persistent()
        .get(&campaign_key(env, id))
        .unwrap_or_else(|| panic!("campaign not found"))
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

        client.init();

        let id = client.create_campaign(
            &creator,
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

        client.init();

        let id = client.create_campaign(
            &creator,
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
