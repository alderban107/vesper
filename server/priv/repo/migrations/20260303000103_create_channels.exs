defmodule Vesper.Repo.Migrations.CreateChannels do
  use Ecto.Migration

  def change do
    create table(:channels, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :server_id, references(:servers, type: :binary_id, on_delete: :delete_all), null: false
      add :name, :string, size: 100, null: false
      add :type, :string, size: 8, null: false, default: "text"
      add :topic, :text
      add :position, :integer, null: false, default: 0
      add :disappearing_ttl, :integer

      timestamps(type: :utc_datetime)
    end

    create index(:channels, [:server_id])
  end
end
