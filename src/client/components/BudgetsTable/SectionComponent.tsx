import { call, DeepPartial, numberToCommaString, useAppContext } from "client";
import { useMemo, useRef, useState } from "react";
import { NewCategoryGetResponse, Section } from "server";
import CategoryComponent from "./CategoryComponent";

interface Props {
  section: Section;
}

const SectionComponent = ({ section }: Props) => {
  const { section_id, name, capacities } = section;

  const { sections, setSections, categories, setCategories, selectedInterval } =
    useAppContext();

  const [nameInput, setNameInput] = useState(name);
  const [capacityInput, setCapacityInput] = useState(
    numberToCommaString(capacities[selectedInterval])
  );

  const onClickAdd = async () => {
    const queryString = "?" + new URLSearchParams({ parent: section_id }).toString();
    const newCategoryRequestUrl = "/api/new-category" + queryString;
    const { data } = await call.get<NewCategoryGetResponse>(newCategoryRequestUrl);

    setCategories((oldCategories) => {
      const newCategories = new Map(oldCategories);
      const category_id = data?.category_id;
      if (category_id) {
        newCategories.set(category_id, {
          category_id,
          section_id,
          name: "",
          capacities: { year: 0, month: 0, week: 0, day: 0 },
        });
      }

      return newCategories;
    });
  };

  const revertInputs = () => {
    setNameInput(name);
    setCapacityInput(numberToCommaString(capacities[selectedInterval]));
  };

  const categoryComponents = useMemo(() => {
    const components: JSX.Element[] = [];
    categories.forEach((e) => {
      if (e.section_id !== section_id) return;
      const component = <CategoryComponent key={e.category_id} category={e} />;
      components.push(component);
    });
    return components;
  }, [categories, section_id]);

  type SetTimeout = typeof setTimeout;
  type Timeout = ReturnType<SetTimeout>;

  const timeout = useRef<Timeout>();

  const submit = (updatedSection: DeepPartial<Section> = {}, delay = 500) => {
    clearTimeout(timeout.current);
    timeout.current = setTimeout(async () => {
      try {
        const { status } = await call.post("/api/section", {
          ...updatedSection,
          section_id,
        });
        if (status === "success") {
          setSections((oldSections) => {
            const newSections = new Map(oldSections);
            const oldSection = oldSections.get(section_id);
            const newSection = { ...oldSection, ...updatedSection };
            newSections.set(section_id, newSection as Section);
            return newSections;
          });
        } else throw new Error(`Failed to update section: ${section_id}`);
      } catch (error: any) {
        console.error(error);
        revertInputs();
      }
    }, delay);
  };

  const onClickRemove = async () => {
    const queryString = "?" + new URLSearchParams({ id: section_id }).toString();
    const { status } = await call.delete("/api/section" + queryString);
    if (status === "success") {
      setSections((oldSections) => {
        const newSections = new Map(oldSections);
        newSections.delete(section_id);
        return newSections;
      });
    }
  };

  const currentTotal = useMemo(() => {
    let total = 0;
    categories.forEach((e) => {
      if (!e.amount) return;
      const parentSection = sections.get(e.section_id);
      if (!parentSection) return;
      if (parentSection !== section) return;
      total += e.amount || 0;
    });
    return total;
  }, [categories, sections, section]);

  return (
    <div className="SectionComponent">
      <div className="sectionInfo">
        <button onClick={onClickRemove}>-</button>
        <input
          placeholder="name"
          value={nameInput}
          onChange={(e) => {
            const { value } = e.target;
            setNameInput(value);
            submit({ name: value });
          }}
        />
        <div className="currentTotal">{numberToCommaString(currentTotal)}</div>
        <span> / </span>
        <input
          value={capacityInput}
          onKeyPress={(e) => !/[0-9.-]/.test(e.key) && e.preventDefault()}
          onChange={(e) => {
            const { value } = e.target;
            setCapacityInput(value);
            submit({ capacities: { [selectedInterval]: +value } });
          }}
          onFocus={(e) => setCapacityInput(e.target.value.replaceAll(",", ""))}
          onBlur={(e) => setCapacityInput(numberToCommaString(+e.target.value || 0))}
        />
      </div>
      <div className="children">
        <div>Categories:</div>
        <div>
          <button onClick={onClickAdd}>+</button>
        </div>
        <div>{categoryComponents}</div>
      </div>
    </div>
  );
};

export default SectionComponent;
