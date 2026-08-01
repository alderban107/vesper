defmodule Vesper.Repo.Migrations.AddHistoryAuthorizationFences do
  use Ecto.Migration

  def up do
    create table(:room_history_authorizations, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :room_id, references(:rooms, type: :binary_id, on_delete: :delete_all), null: false
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :authorization_generation, :binary_id, null: false
      add :authorized_after_room_seq, :bigint, null: false

      timestamps(type: :utc_datetime)
    end

    create unique_index(:room_history_authorizations, [:room_id, :user_id])
    create index(:room_history_authorizations, [:user_id])

    create table(:room_key_epoch_authorizations, primary_key: false) do
      add :id, :binary_id, primary_key: true

      add :room_key_epoch_id,
          references(:room_key_epochs, type: :binary_id, on_delete: :delete_all),
          null: false

      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false

      add :cohort_id,
          references(:room_crypto_cohorts, type: :binary_id, on_delete: :delete_all),
          null: false

      add :authorization_generation, :binary_id, null: false

      timestamps(type: :utc_datetime)
    end

    create unique_index(:room_key_epoch_authorizations, [:room_key_epoch_id, :user_id])
    create index(:room_key_epoch_authorizations, [:user_id, :authorization_generation])

    # Existing current tenures are grandfathered from sequence zero. Deleted
    # historical membership rows cannot be reconstructed safely; all future
    # joins capture an exact room-sequence fence under the room lock.
    execute("""
    INSERT INTO room_history_authorizations
      (id, room_id, user_id, authorization_generation, authorized_after_room_seq, inserted_at, updated_at)
    SELECT gen_random_uuid(), room.id, membership.user_id, membership.id, 0, NOW(), NOW()
    FROM rooms AS room
    JOIN memberships AS membership ON membership.server_id = room.server_id
    WHERE room.server_id IS NOT NULL
    ON CONFLICT (room_id, user_id) DO NOTHING
    """)

    execute("""
    INSERT INTO room_history_authorizations
      (id, room_id, user_id, authorization_generation, authorized_after_room_seq, inserted_at, updated_at)
    SELECT gen_random_uuid(), room.id, participant.user_id, participant.id, 0, NOW(), NOW()
    FROM rooms AS room
    JOIN dm_participants AS participant ON participant.conversation_id = room.conversation_id
    WHERE room.conversation_id IS NOT NULL
    ON CONFLICT (room_id, user_id) DO NOTHING
    """)

    execute("""
    INSERT INTO room_history_authorizations
      (id, room_id, user_id, authorization_generation, authorized_after_room_seq, inserted_at, updated_at)
    SELECT gen_random_uuid(), room.id, membership.user_id, membership.id, 0, NOW(), NOW()
    FROM rooms AS room
    JOIN memberships AS membership ON membership.channel_id = room.channel_id
    WHERE room.channel_id IS NOT NULL AND room.server_id IS NULL
    ON CONFLICT (room_id, user_id) DO NOTHING
    """)

    # Existing completed room-key epochs are grandfathered to the current
    # application tenure. Future activations snapshot exact tenure generations.
    execute("""
    INSERT INTO room_key_epoch_authorizations
      (id, room_key_epoch_id, user_id, cohort_id, authorization_generation, inserted_at, updated_at)
    SELECT
      gen_random_uuid(),
      epoch.id,
      history_auth.user_id,
      cohort_membership.cohort_id,
      history_auth.authorization_generation,
      NOW(),
      NOW()
    FROM room_key_epochs AS epoch
    JOIN room_history_authorizations AS history_auth ON history_auth.room_id = epoch.room_id
    JOIN room_crypto_cohort_memberships AS cohort_membership
      ON cohort_membership.topology_id = epoch.topology_id
      AND cohort_membership.user_id = history_auth.user_id
    WHERE epoch.state IN ('staged', 'active', 'retired')
    ON CONFLICT (room_key_epoch_id, user_id) DO NOTHING
    """)

    alter table(:messages) do
      add :history_signing_public_key, :binary
      add :history_revision, :bigint, null: false, default: 0
    end

    # Pending recovery artifacts are short-lived and cannot be safely upgraded:
    # their original rows contain no server-authenticated application tenure.
    execute("DELETE FROM mls_pending_history_bundles")
    execute("DELETE FROM mls_pending_history_requests")

    alter table(:mls_pending_history_requests) do
      add :authorization_generation, :binary_id, null: false
      add :authorized_after_room_seq, :bigint, null: false
    end

    alter table(:mls_pending_history_bundles) do
      add :request_id, :binary_id
      add :membership_generation, :integer
      add :authorization_generation, :binary_id
      add :authorized_after_room_seq, :bigint
    end

    drop unique_index(
           :mls_pending_history_bundles,
           [:group_id, :recipient_id, :recipient_client_id, :sender_id],
           name: :mls_pending_history_bundles_group_recipient_sender_index
         )

    create unique_index(:mls_pending_history_bundles, [:request_id],
             where: "request_id IS NOT NULL",
             name: :mls_pending_history_bundles_bound_request_index
           )

    create unique_index(
             :mls_pending_history_bundles,
             [:group_id, :recipient_id, :recipient_client_id, :sender_id],
             where: "request_id IS NULL",
             name: :mls_pending_history_bundles_unbound_recipient_sender_index
           )

    create index(:mls_pending_history_bundles, [:authorization_generation])
  end

  def down do
    execute("DELETE FROM mls_pending_history_bundles")

    drop index(:mls_pending_history_bundles, [:authorization_generation])

    drop index(:mls_pending_history_bundles, [:request_id],
           name: :mls_pending_history_bundles_bound_request_index
         )

    drop index(
           :mls_pending_history_bundles,
           [:group_id, :recipient_id, :recipient_client_id, :sender_id],
           name: :mls_pending_history_bundles_unbound_recipient_sender_index
         )

    create unique_index(
             :mls_pending_history_bundles,
             [:group_id, :recipient_id, :recipient_client_id, :sender_id],
             name: :mls_pending_history_bundles_group_recipient_sender_index
           )

    alter table(:mls_pending_history_bundles) do
      remove :authorized_after_room_seq
      remove :authorization_generation
      remove :membership_generation
      remove :request_id
    end

    alter table(:mls_pending_history_requests) do
      remove :authorized_after_room_seq
      remove :authorization_generation
    end

    alter table(:messages) do
      remove :history_revision
      remove :history_signing_public_key
    end

    drop table(:room_key_epoch_authorizations)
    drop table(:room_history_authorizations)
  end
end
